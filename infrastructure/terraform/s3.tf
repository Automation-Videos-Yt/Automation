resource "random_string" "bucket_suffix" {
  length  = 8
  special = false
  upper   = false
}

resource "aws_s3_bucket" "app_storage" {
  bucket = "${var.project_name}-app-storage-${var.environment}-${random_string.bucket_suffix.result}"
}

resource "aws_s3_bucket_lifecycle_configuration" "app_storage_lifecycle" {
  bucket = aws_s3_bucket.app_storage.id

  rule {
    id     = "delete-after-14-days"
    status = "Enabled"
    
    filter {}

    expiration {
      days = 14
    }
  }
}

resource "aws_s3_bucket" "db_backups" {
  bucket = "${var.project_name}-db-backups-${var.environment}-${random_string.bucket_suffix.result}"
}

resource "aws_s3_bucket_lifecycle_configuration" "db_backups_lifecycle" {
  bucket = aws_s3_bucket.db_backups.id

  rule {
    id     = "delete-after-30-days"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }
  }
}
