output "app_public_ip" {
  value = aws_eip.app.public_ip
}

output "app_private_ip" {
  value = aws_instance.app.private_ip
}

output "runtime_secret_id" {
  value = aws_secretsmanager_secret.runtime.id
}

output "s3_bucket" {
  value = aws_s3_bucket.data.bucket
}

output "oracle_host" {
  value = aws_db_instance.oracle.address
}

output "postgres_host" {
  value = aws_db_instance.postgres.address
}

output "mysql_host" {
  value = aws_db_instance.mysql.address
}

output "site_url" {
  value = "https://${var.domain}"
}

output "external_url" {
  value = var.external_domain == "" ? "" : "https://${var.external_domain}"
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}
