import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sources = [
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".gitignore",
  ".env.example",
  "src",
  "demo",
  "scripts",
  "test",
  "docs",
  "artifacts",
  ".github",
];
const requiredEvidence = [
  "docs/mcp-tools.json",
  "artifacts/demo-report.json",
  "artifacts/test-results.txt",
];
for (const evidence of requiredEvidence) await lstat(path.join(root, evidence));

const files = [];
async function collect(relative) {
  const absolute = path.join(root, relative);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to package a symbolic link: ${relative}`);
  }
  const name = path.basename(relative);
  if (
    (name.startsWith(".env") && name !== ".env.example") ||
    /\.(pem|key|p12|pfx|log)$/i.test(name) ||
    ["node_modules", "dist", ".git", "submission"].includes(name)
  ) {
    throw new Error(`Refusing to package an excluded or secret-looking path: ${relative}`);
  }
  if (stat.isDirectory()) {
    for (const entry of (await readdir(absolute)).sort()) {
      await collect(path.join(relative, entry));
    }
  } else if (stat.isFile()) {
    files.push(relative);
  } else {
    throw new Error(`Refusing to package a non-regular file: ${relative}`);
  }
}
for (const source of sources) await collect(source);

const outputDirectory = path.join(root, "submission");
await mkdir(outputDirectory, { recursive: true });
const name = "razorpay-freshdesk-mcp-source.zip";
const destination = path.join(outputDirectory, name);
const temporary = path.join(
  outputDirectory,
  `source-${randomBytes(8).toString("hex")}.zip`,
);
try {
  const result = spawnSync("zip", ["-q", temporary, ...files], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr.trim()}`);
  }
  await rename(temporary, destination);
} catch (error) {
  try {
    await unlink(temporary);
  } catch (cleanupError) {
    if (cleanupError.code !== "ENOENT") throw cleanupError;
  }
  throw error;
}
const digest = createHash("sha256")
  .update(await readFile(destination))
  .digest("hex");
await writeFile(`${destination}.sha256`, `${digest}  ${name}\n`);
console.log(`Packaged ${files.length} allowlisted source/evidence files.`);
console.log(`Archive: ${destination}`);
console.log(`SHA-256: ${digest}`);
