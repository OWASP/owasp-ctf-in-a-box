// Where deploy.sh pushes the images ECS pulls.
//
// The EC2 box built its images ON the instance from a git checkout. Fargate
// pulls prebuilt ones, which moves the build off the box and into a deploy
// step. deploy.sh owns that; Terraform cannot build an image. Config v2
// (#386) removed the app's build-time config — GITHUB_ORG and ADMIN_LOGINS
// are runtime environment reads (ecs.tf) now, so the image itself no longer
// varies per event.
//
// Scanning is on: this image carries the event, and a base-image CVE is worth
// hearing about from the registry rather than from a contestant.

locals {
  // Both exist exactly when this event runs secure-development — poll is the
  // only score transport (#377, ADR 56), so the poller is never optional.
  // Same rule as the compose profiles, and the reason a quiz-only event brings
  // up neither.
  run_scorer = var.enable_secure_development
  run_sync   = var.enable_secure_development

  // Every image a task runs, except srh (a public, digest-pinned third-party
  // image), comes from a repository here. deploy.sh fills them: it builds the
  // app and sync, and MIRRORS the scorer from the event org's package.
  //
  // The scorer and sync used to be "pulled from wherever the operator points
  // them", and there was nowhere that worked (#476): the scorer package is
  // private by contract (setup/ctf-setup.sh keeps it so until launch), so an
  // anonymous Fargate pull is a CannotPullContainerError, and sync is not
  // published anywhere at all. A hand-made repository for either would also
  // survive `terraform destroy`. Here they follow the secdev rule like the
  // services themselves: a quiz-only event creates neither.
  repositories = toset(concat(
    ["app"],
    local.run_scorer ? ["scorer"] : [],
    local.run_sync ? ["sync"] : [],
  ))

  // The ARN of each repository, built from its name rather than read off the
  // resource, for the reason iam.tf gives for its policy locals: a plannable
  // string is something stack.tftest.hcl can compare for equality, where a
  // provider-computed attribute under mock_provider proves nothing.
  repository_arns = {
    for k in local.repositories :
    k => "arn:${data.aws_partition.current.partition}:ecr:${var.region}:${data.aws_caller_identity.current.account_id}:repository/${var.name}-${k}"
  }

  // What deploy.sh's image refs look like: this account, this region, this
  // stack's repository. variables.tf validates scorer_image and sync_image
  // against it.
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"

  // The value terraform.tfvars.example gives the three image variables before
  // deploy.sh has run: legal for the bootstrap apply, which targets only the
  // registry and the KMS key, and refused by a precondition on each task
  // definition, so a full apply with it fails at plan with a sentence instead
  // of timing out on a CannotPullContainerError.
  image_placeholder = "PLACEHOLDER-deploy.sh-overwrites-this"
}

resource "aws_ecr_repository" "main" {
  for_each = local.repositories

  name = "${var.name}-${each.key}"

  // Immutable tags: a deploy that reuses a tag with different content would
  // make "which image is running" unanswerable after the fact.
  image_tag_mutability = "IMMUTABLE"

  // The whole point of this module is that `terraform destroy` ends the event.
  // A repository that refuses to go because it still holds images would leave
  // that half-done.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

// An event is a handful of deploys and every one keeps a tag. Ten is enough to
// roll back through a bad afternoon without paying to store a year of them.
resource "aws_ecr_lifecycle_policy" "main" {
  for_each = aws_ecr_repository.main

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
