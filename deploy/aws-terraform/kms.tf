// One customer-managed key for every SecureString this event uses.
//
// WHY NOT THE DEFAULT `alias/aws/ssm` KEY: the execution role needs
// `kms:Decrypt` to read its SecureStrings, and the AWS-managed SSM key cannot
// be named as a policy resource in a way that scopes to this event — it is
// shared by every Parameter Store SecureString in the account. Granting
// `kms:Decrypt` on `"*"` (even conditioned on `kms:ViaService`) therefore lets
// this role decrypt any parameter in the account whose key delegates access to
// IAM, which is every SecureString anybody else stored under the default key.
// A dedicated key makes the grant in iam.tf name exactly one resource.
//
// THE OPERATOR MUST USE THIS KEY for the secrets they create by hand. The
// module writes the two parameters it generates itself (elasticache.tf), but
// BETTER_AUTH_SECRET, GITHUB_CLIENT_SECRET, SRH_TOKEN and GITHUB_TOKEN are
// `aws ssm put-parameter` calls an operator makes — and a parameter encrypted
// under a different key cannot be decrypted by the scoped grant, so the task
// fails to start with an `AccessDeniedException` on the KMS key rather than
// anything that names the real problem. `outputs.tf` prints the `--key-id`
// argument as part of those instructions for exactly this reason.
resource "aws_kms_key" "secrets" {
  description = "OWASP CTF in a Box event secrets for ${var.name} (SSM SecureStrings)"

  // Rotation does NOT re-encrypt the SecureStrings already stored. KMS keeps
  // the prior key material and picks the right version when decrypting, so a
  // rotation is invisible to SSM and to the tasks — which is the useful part,
  // but is not the same as "SSM re-encrypts", which is what an earlier version
  // of this comment claimed. It is also not free: the first two rotations each
  // add the monthly key-material fee, and rotations after that do not.
  enable_key_rotation = true

  // Long enough to be a real safety net if an event is torn down before its
  // archive is exported, short enough that a destroyed test stack does not
  // bill for a month. AWS's minimum is 7.
  deletion_window_in_days = 7

  // No explicit key policy: the default grants the account root full access,
  // which is what lets the IAM policy in iam.tf delegate `kms:Decrypt` to the
  // execution role at all. A hand-written policy that omitted root would make
  // the key unmanageable and the IAM grant inert.
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}
