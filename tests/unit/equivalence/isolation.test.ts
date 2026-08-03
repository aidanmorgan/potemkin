import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("equivalence harness isolation", () => {
  it("keeps parity implementation out of production source and package exports", () => {
    const source = sourceFiles(join(process.cwd(), "src"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(/(?:parity|equivalence)/i);

    const entrypoint = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    expect(entrypoint).not.toMatch(/tests[\\/]equivalence|(?:parity|equivalence)/i);
  });

  it("keeps the harness itself in the dedicated test module", () => {
    const harness = sourceFiles(join(process.cwd(), "tests", "equivalence"));
    expect(harness.length).toBeGreaterThan(0);
    expect(harness.every((path) => path.includes(`${join("tests", "equivalence")}`))).toBe(true);
  });
});
