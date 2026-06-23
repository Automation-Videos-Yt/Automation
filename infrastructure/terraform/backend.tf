terraform {
  backend "s3" {
    bucket = "hardik-ai-yt-tfstate-123"
    key    = "ai"
    region = "ap-south-1"
  }
}
