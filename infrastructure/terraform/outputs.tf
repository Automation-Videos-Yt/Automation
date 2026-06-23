output "ec2_public_ip" {
  description = "Public IP of the EC2 instance"
  value       = aws_eip.ec2_eip.public_ip
}

output "application_s3_bucket" {
  description = "Name of the Application S3 Bucket"
  value       = aws_s3_bucket.app_storage.bucket
}

output "backup_s3_bucket" {
  description = "Name of the Backup S3 Bucket"
  value       = aws_s3_bucket.db_backups.bucket
}

output "iam_role_arn" {
  description = "ARN of the EC2 IAM Role"
  value       = aws_iam_role.ec2_role.arn
}
