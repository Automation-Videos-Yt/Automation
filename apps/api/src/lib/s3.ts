import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

const s3Client = new S3Client({ region: env.AWS_REGION });

export async function getPresignedS3Url(key: string, expiresIn = 3600): Promise<string> {
  if (!env.APP_S3_BUCKET) throw new Error("APP_S3_BUCKET is not configured");

  const command = new GetObjectCommand({
    Bucket: env.APP_S3_BUCKET,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

export function isS3Path(path: string): boolean {
  return path.startsWith("s3://");
}

export function getS3KeyFromPath(path: string): string {
  if (!isS3Path(path)) return path;
  const parts = path.replace("s3://", "").split("/");
  parts.shift(); 
  return parts.join("/");
}
