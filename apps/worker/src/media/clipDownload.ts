import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import axios from "axios";
import { scoped } from "../lib/logger";

const log = scoped("clip-download");

export async function downloadClip(url: string, outputPath: string): Promise<number> {
  const started = Date.now();
  log.info({ url, outputPath }, "download start");
  const res = await axios.get<NodeJS.ReadableStream>(url, {
    responseType: "stream",
    timeout: 60_000,
    maxRedirects: 5,
  });

  const ws = createWriteStream(outputPath);
  let bytes = 0;
  res.data.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  await pipeline(res.data, ws);
  log.info(
    { bytes, elapsedMs: Date.now() - started, outputPath },
    "download done"
  );
  return bytes;
}
