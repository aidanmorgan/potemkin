import * as fs from 'node:fs/promises';
import { glob } from 'tinyglobby';
import { XMLParser } from 'fast-xml-parser';
import { isRecord } from '../contracts/value.js';
import {
  toConformanceFilePath,
  toConformanceHttpMethod,
  toConformanceReportId,
  toConformanceRequestPath,
  toConformanceStatusToken,
  type ConformanceFilePath,
  type ConformanceHttpMethod,
  type ConformanceReportId,
  type ConformanceRequestPath,
  type ConformanceStatusToken,
  type ConformanceFailure,
  type ConformanceReport,
  type ConformanceTestCase,
} from './types.js';

const XML_TEXT_KEY = '#text';
const XML_CDATA_KEY = '#' + 'cdata';
const XML_ATTRIBUTES_KEY = ':@';

interface XmlText {
  readonly kind: 'text';
  readonly value: string;
}

interface XmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlContent[];
}

type XmlContent = XmlElement | XmlText;

const xmlParser = new XMLParser({
  attributeNamePrefix: '@_',
  cdataPropName: XML_CDATA_KEY,
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  preserveOrder: true,
  removeNSPrefix: true,
  trimValues: false,
});

function asXmlValues(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

function attributes(record: Record<string, unknown>): Readonly<Record<string, string>> {
  const raw = record[XML_ATTRIBUTES_KEY];
  if (!isRecord(raw)) return {};
  const values: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith('@_') && typeof value === 'string') values.push([name.slice(2), value]);
  }
  return Object.fromEntries(values);
}

function cdataContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(cdataContent).join('');
  if (!isRecord(value)) return '';
  return Object.entries(value)
    .filter(([name]) => name === XML_TEXT_KEY || name === XML_CDATA_KEY)
    .map(([, child]) => cdataContent(child))
    .join('');
}

function orderedContents(value: unknown): readonly XmlContent[] {
  return asXmlValues(value).flatMap((item): readonly XmlContent[] => {
    if (typeof item === 'string') return [{ kind: 'text', value: item }];
    if (!isRecord(item)) return [];
    const text = item[XML_TEXT_KEY];
    const cdata = item[XML_CDATA_KEY];
    const element = Object.entries(item).find(
      ([name]) =>
        name !== XML_ATTRIBUTES_KEY &&
        name !== XML_TEXT_KEY &&
        name !== XML_CDATA_KEY &&
        !name.startsWith('?'),
    );
    if (!element) {
      const content: XmlText[] = [];
      if (typeof text === 'string') content.push({ kind: 'text', value: text });
      if (cdata !== undefined) content.push({ kind: 'text', value: cdataContent(cdata) });
      return content;
    }
    const [name, children] = element;
    return [
      {
        kind: 'element',
        name,
        attributes: attributes(item),
        children: orderedContents(children),
      },
    ];
  });
}

function parseXmlDocument(value: unknown): readonly XmlElement[] {
  return orderedContents(value).filter((item): item is XmlElement => item.kind === 'element');
}

function childElements(node: XmlElement): readonly XmlElement[] {
  return node.children.filter((child): child is XmlElement => child.kind === 'element');
}

function collectElements(nodes: readonly XmlElement[], name: string, result: XmlElement[]): void {
  for (const node of nodes) {
    if (node.name === name) result.push(node);
    collectElements(childElements(node), name, result);
  }
}

function textContent(node: XmlElement): string {
  const chunks = node.children.map((child) =>
    child.kind === 'text' ? child.value : ` ${textContent(child)} `,
  );
  return chunks.join('').replace(/\s+/g, ' ').trim();
}

function field(details: string, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const match = details.match(
      new RegExp(`(?:^|[\\s,;])${name}\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,;]+))`, 'i'),
    );
    if (match) return match[1] ?? match[2] ?? match[3];
  }
  return fallback;
}

function diagnosticStatus(
  details: string,
  kind: 'expected' | 'actual',
): ConformanceStatusToken | undefined {
  const pattern =
    kind === 'expected'
      ? /specification\s+expected\s+status\s+([\w-]+)/i
      : /response\s+contained\s+status\s+([\w-]+)/i;
  const value = details.match(pattern)?.[1];
  return value === undefined ? undefined : toConformanceStatusToken(value);
}

function diagnosticApi(
  details: string,
): { readonly method: ConformanceHttpMethod; readonly path: ConformanceRequestPath } | undefined {
  const match = details.match(/(?:^|\s)API:\s*([A-Z]+)\s+(\S+)\s+->/im);
  if (!match) return undefined;
  return {
    method: toConformanceHttpMethod(match[1]),
    // Specmatic writes path parameters as `(id:uuid)` in JUnit diagnostics;
    // normalize that notation to the OpenAPI template used by allowlists.
    path: toConformanceRequestPath(match[2].replace(/\(([^/:()]+):[^()]+\)/g, '{$1}')),
  };
}

function testcaseApi(testName: string):
  | {
      readonly method: ConformanceHttpMethod;
      readonly path: ConformanceRequestPath;
      readonly status: ConformanceStatusToken;
    }
  | undefined {
  const match = testName.match(/Scenario:\s*([A-Z]+)\s+(\S+)\s*(?:->|→)\s*([\w-]+)/i);
  if (!match) return undefined;
  return {
    method: toConformanceHttpMethod(match[1]),
    path: toConformanceRequestPath(match[2].replace(/\(([^/:()]+):[^()]+\)/g, '{$1}')),
    status: toConformanceStatusToken(match[3]),
  };
}

function testcaseScenario(testName: string): string | undefined {
  return testName.match(/request from the example\s+['"]([^'"]+)['"]/i)?.[1];
}

function diagnosticScenario(details: string): string | undefined {
  return details.match(/Testing\s+scenario\s+["']([^"']+)["']/i)?.[1];
}

type ParsedTestCase = Omit<
  ConformanceTestCase,
  'testName' | 'method' | 'path' | 'expectedStatus' | 'actualStatus'
> & {
  readonly testName: ConformanceReportId;
  readonly method: ConformanceHttpMethod;
  readonly path: ConformanceRequestPath;
  readonly expectedStatus: ConformanceStatusToken;
  readonly actualStatus: ConformanceStatusToken;
  readonly failureKind?: 'failure' | 'error';
};

function parseTestCase(node: XmlElement): ParsedTestCase {
  const attrs = node.attributes;
  const failureNode = childElements(node).find(
    (child) => child.name === 'failure' || child.name === 'error',
  );
  const skipped = childElements(node).some((child) => child.name === 'skipped');
  const failureName = failureNode?.name;
  const failureAttrs = failureNode?.attributes ?? {};
  const details = failureNode ? textContent(failureNode) : '';
  // Specmatic places the human-readable API/status diagnostic in the
  // failure's `message` attribute, while the element body is often only a
  // stack trace. Parse both so JUnit identities do not degrade to UNKNOWN.
  const testName = toConformanceReportId(attrs.name ?? 'unnamed Specmatic test');
  const testcaseIdentity = testcaseApi(testName);
  const diagnosticText = [failureAttrs.message, details].filter(Boolean).join('\n');
  const message = failureNode
    ? failureAttrs.message || failureAttrs.type || details || 'Specmatic test failed'
    : '';
  const api = diagnosticApi(diagnosticText);
  const scenario =
    field(diagnosticText, ['scenario', 'example', 'example-name'], '') ||
    diagnosticScenario(diagnosticText) ||
    testcaseScenario(testName) ||
    testName;
  const method = toConformanceHttpMethod(
    field(diagnosticText, ['method', 'http-method'], '') ||
      api?.method ||
      testcaseIdentity?.method ||
      'UNKNOWN',
  );
  const requestPath = toConformanceRequestPath(
    field(diagnosticText, ['path', 'request-path', 'url'], '') ||
      api?.path ||
      testcaseIdentity?.path ||
      'UNKNOWN',
  );
  const expectedFromDiagnostics =
    diagnosticStatus(diagnosticText, 'expected') ??
    field(diagnosticText, ['expected', 'expected-status', 'expected-status-code'], '');
  const actualFromDiagnostics =
    diagnosticStatus(diagnosticText, 'actual') ??
    field(diagnosticText, ['actual', 'actual-status', 'actual-status-code'], '');
  const expectedStatus = toConformanceStatusToken(
    expectedFromDiagnostics || testcaseIdentity?.status || 'UNKNOWN',
  );
  const actualStatus = toConformanceStatusToken(
    actualFromDiagnostics || testcaseIdentity?.status || 'UNKNOWN',
  );
  const ruleId = field(details, ['rule-id', 'rule'], '') || undefined;
  const kind = failureName === 'failure' || failureName === 'error' ? failureName : undefined;

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
    passed: failureNode === undefined && !skipped,
    skipped,
    ...(ruleId ? { ruleId } : {}),
    ...(kind === undefined ? {} : { failureKind: kind }),
  };
}

export function parseJunitXml(xml: string, sourceFile = '<memory>'): ConformanceReport {
  const parsed = parseXmlDocument(xmlParser.parse(xml));
  const root = parsed[0];
  const suiteNodes: XmlElement[] = [];
  collectElements(parsed, 'testsuite', suiteNodes);
  const suiteAttrs = suiteNodes.map((suite) => suite.attributes);
  const rootAttrs = root?.name === 'testsuites' ? root.attributes : {};
  const totalsAttrs = Object.keys(rootAttrs).length > 0 ? rootAttrs : (suiteAttrs[0] ?? {});
  const testcaseNodes: XmlElement[] = [];
  collectElements(parsed, 'testcase', testcaseNodes);
  const testCases = testcaseNodes.map(parseTestCase);
  const cases = testCases
    .filter((value) => value.failureKind !== undefined)
    .map((value) => parseCaseFromParsed(value));

  const count = (name: 'tests' | 'failures' | 'errors' | 'skipped', fallback: number): number => {
    const rootValue = Number(totalsAttrs[name]);
    if (Number.isFinite(rootValue)) return rootValue;
    const suiteValues = suiteAttrs
      .map((attrs) => Number(attrs[name]))
      .filter((value) => Number.isFinite(value));
    if (suiteValues.length > 0) return suiteValues.reduce((total, value) => total + value, 0);
    return fallback;
  };
  return {
    tests: count('tests', cases.length),
    failures: count('failures', cases.length),
    errors: count('errors', 0),
    skipped: count('skipped', 0),
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

export async function findJunitFiles(reportDir: string): Promise<ConformanceFilePath[]> {
  try {
    const stat = await fs.stat(reportDir);
    if (!stat.isDirectory()) throw new Error('path is not a directory');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Specmatic did not produce a JUnit report directory at ${reportDir}: ${reason}`,
    );
  }
  try {
    const files = await glob('**/*.xml', {
      absolute: true,
      caseSensitiveMatch: false,
      cwd: reportDir,
      dot: true,
      onlyFiles: true,
    });
    return files.sort().map(toConformanceFilePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Specmatic did not produce a JUnit report directory at ${reportDir}: ${reason}`,
    );
  }
}

export async function parseJunitDirectory(reportDir: string): Promise<ConformanceReport> {
  const sourceFiles = await findJunitFiles(reportDir);
  if (sourceFiles.length === 0) {
    throw new Error(`Specmatic completed without any JUnit XML reports in ${reportDir}`);
  }
  const reports = await Promise.all(
    sourceFiles.map(async (file) => parseJunitXml(await fs.readFile(file, 'utf8'), file)),
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
