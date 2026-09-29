// Two roles per the ECS split, kept genuinely distinct.
//
//   - EXECUTION role: what the ECS agent uses to START a task — pull the
//     image, resolve `secrets[].valueFrom`, write to the log group. The
//     container never holds these credentials.
//   - TASK role: what the application code inside the container gets. Created
//     with NO policies attached, deliberately: nothing in this stack calls an
//     AWS API at runtime. The app speaks to srh, srh speaks to ElastiCache,
//     sync speaks to GitHub. Attaching anything here would hand a
//     contestant-facing container an AWS identity it has no use for.
//
// The execution role's secret access is scoped to the event's own SSM prefix
// rather than `ssm:*`: an execution role that can read every parameter in the
// account is a lateral-movement primitive, and this one needs a handful of
// values.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    // Confused-deputy guard: assumable only on behalf of a task in THIS
    // account.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name}-exec-"
  description        = "ECS agent: pull images, read this event's secrets, write logs"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

// Image pulls and log writes, NAMED — in place of the AWS-managed
// AmazonECSTaskExecutionRolePolicy this role used to carry.
//
// That managed policy grants the same six actions on `"*"`: this role could
// pull every ECR repository in the account and write to every log group.
// With the scorer and sync now in this stack's own repositories (#476), the
// grant can say exactly which three images a task may run, and
// stack.tftest.hcl asserts it does. srh needs nothing here: it is a public
// Docker Hub image, pulled anonymously.
//
// A local for iam.tf's own reason below: a data source's rendered json is
// empty under mock_provider, and an assertion over an empty list passes.
locals {
  execution_pull_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PullThisEventsImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = [for k in sort(tolist(local.repositories)) : local.repository_arns[k]]
      },
      // The one `"*"` in this role, and not a choice: GetAuthorizationToken
      // is account-wide and supports no resource-level permission at all
      // (the ECR IAM reference lists no resource type for it). The token it
      // returns pulls nothing on its own — each pull is still checked against
      // the statement above.
      {
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = ["*"]
      },
      {
        Sid    = "WriteThisEventsLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = [
          for service in sort(keys(aws_cloudwatch_log_group.main)) :
          "arn:${data.aws_partition.current.partition}:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${var.name}/${service}:*"
        ]
      },
    ]
  }
}

resource "aws_iam_role_policy" "execution_pull" {
  name   = "pull-event-images-write-logs"
  role   = aws_iam_role.execution.id
  policy = jsonencode(local.execution_pull_policy)
}

// BUILT AS A LOCAL AND `jsonencode`d, not rendered by
// `data.aws_iam_policy_document`.
//
// The data source reads better, and this module used it until PR #354's
// review asked for the decrypt grant to be scoped. Making that scoping
// TESTABLE is what forced the change: a data source's `json` is computed by
// the provider, so under `mock_provider` it comes back as
// `{"Version":"2012-10-17","Statement":[]}` — and an assertion that no
// statement uses a `"*"` resource passes over an empty list. It passed
// vacuously the first time I wrote it, which is the failure mode this repo
// keeps a whole sweep for.
//
// A local is plannable with no provider at all, so stack.tftest.hcl can
// assert on the real statements. Same lesson as the note in AGENTS.md about
// `terraform validate` never inspecting rendered template output: if a check
// cannot see the thing, it is not checking it.
locals {
  execution_secrets_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadThisEventsSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = ["arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_prefix}/*"]
      },
      // Scoped to THIS EVENT'S KEY, not `"*"`.
      //
      // The `kms:ViaService` condition alone was not enough, and the review
      // was right about why: it narrows the grant to KMS calls made through
      // Parameter Store, but says nothing about WHICH parameters. Every
      // SecureString in the account stored under the default `alias/aws/ssm`
      // key delegates access to IAM, so `"*"` plus that condition let this
      // role decrypt any of them — another event's, or another team's.
      //
      // Naming one key requires that key to exist, which is why kms.tf does.
      // It also means an operator-created parameter encrypted under a
      // DIFFERENT key will not decrypt here, so `outputs.tf` prints the
      // required `--key-id` alongside the `put-parameter` calls: that failure
      // mode is designed out rather than debugged at task-start time.
      {
        Sid      = "DecryptSecureStrings"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.secrets.arn]

        // Kept even though the resource is now specific: it costs nothing,
        // and it means a leaked role cannot use the key for anything but
        // Parameter Store reads — defence in depth, not a substitute for the
        // scope above.
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.region}.amazonaws.com"
          }
        }
      },
    ]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-event-secrets"
  role   = aws_iam_role.execution.id
  policy = jsonencode(local.execution_secrets_policy)
}

// Deliberately policy-less — see the header. It exists so every task
// definition names one, which makes "this container has no AWS permissions" an
// explicit statement rather than an omission somebody later fills in by
// accident.
resource "aws_iam_role" "task" {
  name_prefix        = "${var.name}-task-"
  description        = "Application identity. No policies: nothing here calls an AWS API."
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
