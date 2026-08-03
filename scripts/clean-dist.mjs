import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const workspace = resolve(process.cwd());
const dist = resolve(workspace, "dist");
if (dirname(dist) !== workspace || basename(dist) !== "dist") {
  throw new Error(`Refusing to clean unexpected build directory: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
