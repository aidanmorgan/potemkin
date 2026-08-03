import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import yaml from "js-yaml";
import { glob } from "tinyglobby";

const configPath = path.resolve(process.env.POTEMKIN_CONFIG_PATH ?? "/workspace/potemkin.yml");
const config = yaml.load(await readFile(configPath, "utf8"));
const patterns = config?.openapi;
if (
  !Array.isArray(patterns) ||
  patterns.length === 0 ||
  patterns.some((pattern) => typeof pattern !== "string")
) {
  throw new Error(
    `The Potemkin configuration at ${configPath} must define a non-empty openapi glob array`,
  );
}

const contractPaths = [
  ...new Set(
    await glob(patterns, {
      cwd: path.dirname(configPath),
      absolute: true,
      onlyFiles: true,
    }),
  ),
].sort();
if (contractPaths.length === 0) {
  throw new Error(`No OpenAPI documents matched the configured globs: ${patterns.join(", ")}`);
}

const specmaticJar = process.env.SPECMATIC_JAR ?? "/opt/potemkin/specmatic.jar";
const pluginJar = process.env.POTEMKIN_PLUGIN_JAR ?? "/opt/potemkin/potemkin-stateful-plugin.jar";
const port = process.env.SPECMATIC_PORT ?? "9000";
const child = spawn(
  process.env.JAVA ?? "java",
  [
    "-Xmx512m",
    "-XX:+UseSerialGC",
    "-cp",
    `${specmaticJar}:${pluginJar}`,
    "application.SpecmaticApplication",
    "stub",
    "--port",
    port,
    ...contractPaths,
  ],
  { stdio: "inherit" },
);

const forwardSignal = (signal) => child.kill(signal);
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));
child.once("exit", (code, signal) => {
  if (signal !== null) process.exitCode = 1;
  else if (code !== null) process.exitCode = code;
});
