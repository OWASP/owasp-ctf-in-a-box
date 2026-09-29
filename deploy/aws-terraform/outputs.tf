output "event_url" {
  description = "Where the leaderboard and sign-in answer. Use this as the OAuth app's base, with its callback at /api/auth/callback/github."
  value       = local.event_url
}

output "alb_dns_name" {
  description = "The load balancer's hostname. Point your DNS at this if you did not set route53_zone_id."
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Hosted-zone id of the ALB, for an alias record in a zone this module does not manage."
  value       = aws_lb.main.zone_id
}

output "ecr_app_repository_url" {
  description = "Push the app image here — deploy.sh does. Terraform cannot build images."
  value       = aws_ecr_repository.main["app"].repository_url
}

// "" when the event does not run Secure Development: registry.tf creates the
// repository only then, and deploy.sh reads the empty string as "publish app
// only". A failed read is a different thing, and deploy.sh refuses it.
output "ecr_sync_repository_url" {
  description = "deploy.sh builds ./sync and pushes it here. Empty when enable_secure_development is false."
  value       = local.run_sync ? aws_ecr_repository.main["sync"].repository_url : ""
}

output "ecr_scorer_repository_url" {
  description = "deploy.sh mirrors the event org's scorer package here. Empty when enable_secure_development is false."
  value       = local.run_scorer ? aws_ecr_repository.main["scorer"].repository_url : ""
}

output "cluster_name" {
  description = "ECS cluster, for `aws ecs execute-command` and the console."
  value       = aws_ecs_cluster.main.name
}

output "redis_primary_endpoint" {
  description = "ElastiCache primary endpoint. srh alone can reach it; nothing else has a route."
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "services_running" {
  description = "Which services this event actually runs, following the enabled modules."
  value = compact([
    "app",
    "srh",
    local.run_scorer ? "scorer" : "",
    local.run_sync ? "sync" : "",
  ])
}

output "secrets_kms_key_arn" {
  description = "The KMS key every SecureString under ssm_prefix must use. The execution role's kms:Decrypt names this key and nothing else, so a parameter encrypted under a different key cannot be read by the tasks."
  value       = aws_kms_key.secrets.arn
}

output "next_steps" {
  description = "What to do after apply."
  value       = <<-EOT
    1. Put the event secrets in SSM as SecureStrings under ${var.ssm_prefix},
       ENCRYPTED WITH THIS EVENT'S KEY. --key-id is not optional: the tasks'
       decrypt grant names only this key, so a parameter stored under any
       other one fails at task start with an AccessDeniedException on KMS.
       Replace each "..." with that secret's real value before running it —
       --overwrite would otherwise store the literal "...".

         for s in BETTER_AUTH_SECRET GITHUB_CLIENT_SECRET SRH_TOKEN \
                  GITHUB_APP_PRIVATE_KEY SCORER_TOKEN; do   # the last two: Secure Development only
           aws ssm put-parameter --region ${var.region} \
             --name "${var.ssm_prefix}/$s" --type SecureString \
             --key-id ${aws_kms_alias.secrets.name} \
             --value "..." --overwrite
         done

       (REDIS_AUTH_TOKEN and SRH_CONNECTION_STRING are written there by
       Terraform, already under that key.)
    2. Build, mirror and push the images (app; sync and scorer on a Secure
       Development event):  ./deploy.sh --scorer-source <SCORE_IMAGE>
    3. If you did not set route53_zone_id, point ${var.domain} at ${aws_lb.main.dns_name}
    4. Set the OAuth app callback to ${local.event_url}/api/auth/callback/github
    5. Tear the event down when it ends:  terraform destroy
  EOT
}
