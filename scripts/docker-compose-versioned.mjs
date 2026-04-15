#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const includeRoots = [
  "docker-compose.yml",
  "package.json",
  "package-lock.json",
  "apps",
  "ai-system",
  "infrastructure",
  "scripts",
];

const excludedDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "storage",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  ".turbo",
]);

async function exists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(relPath, files) {
  const absPath = path.join(root, relPath);
  const stat = await fs.lstat(absPath);

  if (stat.isSymbolicLink()) {
    return;
  }

  if (stat.isFile()) {
    files.push(relPath.replace(/\\/g, "/"));
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  const entries = await fs.readdir(absPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) {
      continue;
    }
    const childRel = path.join(relPath, entry.name);
    await collectFiles(childRel, files);
  }
}

async function computeImageTag() {
  const files = [];
  for (const relPath of includeRoots) {
    const absPath = path.join(root, relPath);
    if (!(await exists(absPath))) continue;
    await collectFiles(relPath, files);
  }

  files.sort();

  const hash = createHash("sha256");
  for (const relPath of files) {
    const absPath = path.join(root, relPath);
    const content = await fs.readFile(absPath);
    hash.update(relPath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return `v-${hash.digest("hex").slice(0, 12)}`;
}

async function main() {
  const imageTag = await computeImageTag();
  const composeArgs = process.argv.slice(2);

  if (composeArgs.length === 0) {
    process.stdout.write(`${imageTag}\n`);
    return;
  }

  process.stdout.write(`[docker-versioned] IMAGE_TAG=${imageTag}\n`);

  const child = spawn("docker", ["compose", ...composeArgs], {
    stdio: "inherit",
    cwd: root,
    env: {
      ...process.env,
      IMAGE_TAG: imageTag,
      APP_VERSION: imageTag,
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error("[docker-versioned] failed", err);
  process.exit(1);
});
