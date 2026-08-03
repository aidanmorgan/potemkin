import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("tests");
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);
const forbidden =
  /\b(?:describe|it|test)\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe|ftest)\s*\(/;

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(file)));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(file);
  }
  return files;
}

const violations = [];
for (const file of await filesUnder(root)) {
  const source = await readFile(file, "utf8");
  if (!forbidden.test(source)) continue;
  violations.push(path.relative(process.cwd(), file));
}

if (violations.length > 0) {
  console.error("Executable skipped, focused, or todo test registrations are forbidden:");
  for (const file of violations) console.error(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log("No skipped, focused, or todo test registrations found.");
}
