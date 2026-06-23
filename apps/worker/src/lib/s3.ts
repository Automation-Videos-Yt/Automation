import fs from "node:fs";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../config/env";

const s3Client = new S3Client({ region: env.AWS_REGION });

export async function uploadFileToS3(localPath: string, key: string): Promise<string> {
  if (!env.APP_S3_BUCKET) throw new Error("APP_S3_BUCKET is not configured");
  const fileStream = fs.createReadStream(localPath);
  
  const command = new PutObjectCommand({
    Bucket: env.APP_S3_BUCKET,
    Key: key,
    Body: fileStream,
  });

  await s3Client.send(command);
  return `s3://${env.APP_S3_BUCKET}/${key}`;
}

export async function downloadFileFromS3(key: string, localPath: string): Promise<void> {
  if (!env.APP_S3_BUCKET) throw new Error("APP_S3_BUCKET is not configured");

  const command = new GetObjectCommand({
    Bucket: env.APP_S3_BUCKET,
    Key: key,
  });

  const response = await s3Client.send(command);
  if (!response.Body) throw new Error("S3 object has no body");

  const writeStream = fs.createWriteStream(localPath);
  await pipeline(response.Body as Readable, writeStream);
}

export function isS3Path(path: string): boolean {
  return path.startsWith("s3://");
}

export function getS3KeyFromPath(path: string): string {
  if (!isS3Path(path)) return path;
  // s3://bucket-name/key/path.mp4 -> key/path.mp4
  const parts = path.replace("s3://", "").split("/");
  parts.shift(); // remove bucket
  return parts.join("/");
}
