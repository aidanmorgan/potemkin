import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ConformanceFailure, ConformanceReport, ConformanceTestCase } from "./types.js";

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_match, code: string) => {
      const number = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _match;
    });
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    result[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return result;
}

function textContent(source: string): string {
  return decodeXml(
    source
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function field(details: string, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const match = details.match(
      new RegExp(`(?:^|[\\s,;])${name}\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,;]+))`, "i"),
    );
    if (match) return match[1] ?? match[2] ?? match[3];
  }
  return fallback;
}

function diagnosticStatus(details: string, kind: "expected" | "actual"): string | undefined {
  const pattern =
    kind === "expected"
      ? /specification\s+expected\s+status\s+([\w-]+)/i
      : /response\s+contained\s+status\s+([\w-]+)/i;
  return details.match(pattern)?.[1];
}

function diagnosticApi(details: string): { method: string; path: string } | undefined {
  const match = details.match(/(?:^|\s)API:\s*([A-Z]+)\s+(\S+)\s+->/im);
  if (!match) return undefined;
  return {
    method: match[1].toUpperCase(),
    // Specmatic writes path parameters as `(id:uuid)` in JUnit diagnostics;
    // normalize that notation to the OpenAPI template used by allowlists.
    path: match[2].replace(/\(([^/:()]+):[^()]+\)/g, "{$1}"),
  };
}

function testcaseApi(
  testName: string,
): { method: string; path: string; status: string } | undefined {
  const match = testName.match(/Scenario:\s*([A-Z]+)\s+(\S+)\s*(?:->|→)\s*([\w-]+)/i);
  if (!match) return undefined;
  return {
    method: match[1].toUpperCase(),
    path: match[2].replace(/\(([^/:()]+):[^()]+\)/g, "{$1}"),
    status: match[3],
  };
}

function testcaseScenario(testName: string): string | undefined {
  return testName.match(/request from the example\s+['"]([^'"]+)['"]/i)?.[1];
}

function diagnosticScenario(details: string): string | undefined {
  return details.match(/Testing\s+scenario\s+["']([^"']+)["']/i)?.[1];
}

interface ParsedTestCase extends ConformanceTestCase {
  readonly failureKind?: "failure" | "error";
}

function parseTestCase(source: string): ParsedTestCase | undefined {
  const testMatch = source.match(
    /^\s*<testcase\b([^>]*)(?:>([\s\S]*?)<\/testcase\s*>|\s*\/>)\s*$/i,
  );
  if (!testMatch) return undefined;

  const attrs = attributes(testMatch[1]);
  const body = testMatch[2] ?? "";
  const failureMatch =
    body.match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1\s*>/i) ??
    body.match(/<(failure|error)\b([^>]*)\s*\/\s*>/i);
  const skipped = /<skipped\b(?:[^>]*)\/?>(?:[\s\S]*?<\/skipped\s*>)?/i.test(body);
  const failureAttrs = failureMatch ? attributes(failureMatch[2]) : {};
  const details = failureMatch ? textContent(failureMatch[3] ?? "") : "";
  // Specmatic places the human-readable API/status diagnostic in the
  // failure's `message` attribute, while the element body is often only a
  // stack trace. Parse both so JUnit identities do not degrade to UNKNOWN.
  const testName = attrs.name ?? "unnamed Specmatic test";
  const testcaseIdentity = testcaseApi(testName);
  const diagnosticText = [failureAttrs.message, details].filter(Boolean).join("\n");
  const message = failureMatch
    ? failureAttrs.message || failureAttrs.type || details || "Specmatic test failed"
    : "";
  const api = diagnosticApi(diagnosticText);
  const scenario =
    field(diagnosticText, ["scenario", "example", "example-name"], "") ||
    diagnosticScenario(diagnosticText) ||
    testcaseScenario(testName) ||
    testName;
  const method = (
    field(diagnosticText, ["method", "http-method"], "") ||
    api?.method ||
    testcaseIdentity?.method ||
    "UNKNOWN"
  ).toUpperCase();
  const requestPath =
    field(diagnosticText, ["path", "request-path", "url"], "") ||
    api?.path ||
    testcaseIdentity?.path ||
    "UNKNOWN";
  const expectedFromDiagnostics =
    diagnosticStatus(diagnosticText, "expected") ??
    field(diagnosticText, ["expected", "expected-status", "expected-status-code"], "");
  const actualFromDiagnostics =
    diagnosticStatus(diagnosticText, "actual") ??
    field(diagnosticText, ["actual", "actual-status", "actual-status-code"], "");
  const expectedStatus = expectedFromDiagnostics || testcaseIdentity?.status || "UNKNOWN";
  const actualStatus = actualFromDiagnostics || testcaseIdentity?.status || "UNKNOWN";
  const ruleId = field(details, ["rule-id", "rule"], "") || undefined;

  return {
    testName,
    classname: attrs.classname,
    message,
    details,
    method,
    path: requestPath,
    scenario,
    expectedStatus,
    actualStatus,
    passed: failureMatch === null && !skipped,
    skipped,
    ...(ruleId ? { ruleId } : {}),
    ...(failureMatch ? { failureKind: failureMatch[1].toLowerCase() as "failure" | "error" } : {}),
  };
}

export function parseJunitXml(xml: string, sourceFile = "<memory>"): ConformanceReport {
  const rootMatch = xml.match(/<testsuites\b([^>]*)>/i);
  const suiteAttrs = [...xml.matchAll(/<testsuite\b([^>]*)>/gi)].map((match) =>
    attributes(match[1]),
  );
  const totalsAttrs = rootMatch ? attributes(rootMatch[1]) : (suiteAttrs[0] ?? {});
  // Match self-closing cases before paired cases. If the paired alternative
  // is tried first, a self-closing testcase can consume the next testcase's
  // failure element and corrupt its name/scenario fields.
  const testCases = [
    ...xml.matchAll(/<testcase\b[^>]*\/\s*>|<testcase\b[^>]*>[\s\S]*?<\/testcase\s*>/gi),
  ]
    .map((match) => parseTestCase(match[0]))
    .filter((value): value is ParsedTestCase => value !== undefined);
  const cases = testCases
    .filter((value) => value.failureKind !== undefined)
    .map((value) => parseCaseFromParsed(value));

  const count = (name: string, fallback: number): number => {
    const rootValue = Number(totalsAttrs[name]);
    if (Number.isFinite(rootValue)) return rootValue;
    const suiteValues = suiteAttrs
      .map((attrs) => Number(attrs[name]))
      .filter((value) => Number.isFinite(value));
    if (suiteValues.length > 0) return suiteValues.reduce((total, value) => total + value, 0);
    return fallback;
  };
  return {
    tests: count("tests", cases.length),
    failures: count("failures", cases.length),
    errors: count("errors", 0),
    skipped: count("skipped", 0),
    cases,
    testCases: testCases.map(({ failureKind: _failureKind, ...value }) => value),
    sourceFiles: [sourceFile],
  };
}

function parseCaseFromParsed(testCase: ParsedTestCase): ConformanceFailure {
  return {
    testName: testCase.testName,
    ...(testCase.classname ? { classname: testCase.classname } : {}),
    message: testCase.message,
    details: testCase.details,
    method: testCase.method,
    path: testCase.path,
    scenario: testCase.scenario,
    expectedStatus: testCase.expectedStatus,
    actualStatus: testCase.actualStatus,
    ...(testCase.ruleId ? { ruleId: testCase.ruleId } : {}),
  };
}

export async function findJunitFiles(reportDir: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Specmatic did not produce a JUnit report directory at ${directory}: ${reason}`,
      );
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && /\.xml$/i.test(entry.name)) files.push(fullPath);
    }
  }
  await visit(reportDir);
  return files.sort();
}

export async function parseJunitDirectory(reportDir: string): Promise<ConformanceReport> {
  const sourceFiles = await findJunitFiles(reportDir);
  if (sourceFiles.length === 0) {
    throw new Error(`Specmatic completed without any JUnit XML reports in ${reportDir}`);
  }
  const reports = await Promise.all(
    sourceFiles.map(async (file) => parseJunitXml(await fs.readFile(file, "utf8"), file)),
  );
  return {
    tests: reports.reduce((total, report) => total + report.tests, 0),
    failures: reports.reduce((total, report) => total + report.failures, 0),
    errors: reports.reduce((total, report) => total + report.errors, 0),
    skipped: reports.reduce((total, report) => total + report.skipped, 0),
    cases: reports.flatMap((report) => report.cases),
    testCases: reports.flatMap((report) => report.testCases ?? []),
    sourceFiles,
  };
}
