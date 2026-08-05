import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';
import Ajv from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import { glob } from 'tinyglobby';
import {
  SemanticCompletionKind as CompletionItemKind,
  SemanticDiagnosticSeverity as DiagnosticSeverity,
  SemanticSymbolKind as SymbolKind,
  type SemanticCompletionItem as CompletionItem,
  type SemanticDiagnostic as Diagnostic,
  type SemanticHover as Hover,
  type SemanticLocation as Location,
  type SemanticPosition as Position,
  type SemanticRange as Range,
  type SemanticSymbolInformation as SymbolInformation,
  type SemanticTextEdit as TextEdit,
  type SemanticWorkspaceEdit as WorkspaceEdit,
  type SemanticDocument as TextDocument,
} from './contracts.js';

import type { LoadedConfig } from '../parser/configLoader.js';
import { parseComponent, parseUseMapping, parseYaml } from '../parser/yamlParser.js';
import { validateGlobalConfig } from '../dsl/schema.js';
import { validatePotemkinConfig } from '../dsl/configSchema.js';
import type { OpenApiDoc } from '../contract/loader.js';
import { loadProjectDescriptor } from '../project/descriptor.js';
import type { ScenarioModel } from '../openapi/scenarioModel.js';
import { generateScenarioBindings, type GeneratedScenarioBindings } from '../generation/service.js';

export type AuthoringLanguage = 'yaml' | 'typescript';

export interface LanguageServiceDocument {
  readonly uri: string;
  readonly filePath: string;
  readonly language: AuthoringLanguage;
  readonly text: string;
}

export interface PotemkinProjectOptions {
  readonly workspacePath: string;
  readonly configPath?: string;
  readonly outputDirectory?: string;
}

export interface PotemkinProjectSnapshot {
  readonly openapi: OpenApiDoc;
  readonly loaded: LoadedConfig;
  readonly scenario: ScenarioModel;
  readonly bindings: GeneratedScenarioBindings;
}

const YAML_ROOT_KEYS = [
  'boundary',
  'contract_path',
  'schema',
  'fallback_override',
  'identity',
  'query',
  'query_mapping',
  'event_catalog',
  'behaviors',
  'reducers',
  'initialization',
  'deprecated',
  'hateoas',
  'mask',
  'state',
  'strict_schema',
  'latency',
  'audit_fields',
  'fault_rules',
  'reactions',
  'response',
  'include',
  'export',
] as const;

const CONFIG_ROOT_KEYS = [
  'version',
  'specmatic',
  'modules',
  'openapi',
  'typescript',
  'plugin',
  'seeds',
  'workflow',
  'overlay',
  'governance',
] as const;

const EVENT_VALUE_KEYS = new Set(['emit', 'on', 'type']);
const SCHEMA_VALUE_KEYS = new Set(['schema', 'schema_ref']);
const COMPONENT_VALUE_KEYS = new Set(['component']);
const RESOURCE_VALUE_KEYS = new Set(['resource']);

/**
 * The editor-facing source graph. It intentionally contains only authoring
 * inputs and derived contract metadata; runtime model objects never cross this
 * boundary.
 */
export class PotemkinLanguageService {
  private readonly documents = new Map<string, LanguageServiceDocument>();
  private snapshot: PotemkinProjectSnapshot | undefined;
  private refreshInFlight: Promise<PotemkinProjectSnapshot | undefined> | undefined;
  private lastRefreshError: unknown;
  private readonly configPath: string;

  constructor(private readonly options: PotemkinProjectOptions) {
    this.configPath = resolveConfigPath(options.workspacePath, options.configPath);
  }

  get configurationPath(): string {
    return this.configPath;
  }

  open(document: TextDocument, language: AuthoringLanguage): void {
    const filePath = uriToPath(document.uri);
    this.documents.set(filePath, {
      uri: document.uri,
      filePath,
      language,
      text: document.getText(),
    });
  }

  change(document: TextDocument, language: AuthoringLanguage): void {
    this.open(document, language);
  }

  close(uri: string): void {
    this.documents.delete(uriToPath(uri));
  }

  async refresh(): Promise<PotemkinProjectSnapshot | undefined> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;
    const refresh = this.loadSnapshot();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    }
  }

  async diagnostics(document: TextDocument): Promise<readonly Diagnostic[]> {
    const language = languageFor(document.uri, document.languageId);
    const local = language === 'yaml' ? yamlDiagnostics(document, this.configPath) : [];
    const snapshot = await this.refresh();
    if (snapshot === undefined) {
      return [...local, ...refreshDiagnostic(this.lastRefreshError)];
    }
    if (language === 'yaml') {
      return [
        ...local,
        ...scenarioYamlDiagnostics(document, snapshot.scenario),
        ...(await generatedSchemaDiagnostics(document, snapshot.bindings.yamlSchema.outputFile)),
      ];
    }
    const custom = typescriptEventDiagnostics(document, snapshot.scenario);
    const semantic = await this.typescriptDiagnostics(document, snapshot);
    return deduplicateDiagnostics([...custom, ...semantic]);
  }

  async completions(
    document: TextDocument,
    position: Position,
  ): Promise<readonly CompletionItem[]> {
    const snapshot = await this.refresh();
    if (snapshot === undefined) return [];
    const language = languageFor(document.uri, document.languageId);
    const line = document.getText({
      start: { line: position.line, character: 0 },
      end: position,
    });
    if (language === 'yaml') {
      return yamlCompletions(
        line,
        snapshot.scenario,
        path.resolve(uriToPath(document.uri)) === path.resolve(this.configPath),
        document.getText(),
        position.line,
      );
    }
    return typescriptCompletions(line, snapshot.scenario);
  }

  async definition(document: TextDocument, position: Position): Promise<Location | undefined> {
    const snapshot = await this.refresh();
    if (snapshot === undefined) return undefined;
    const token = wordAt(document, position);
    if (token === undefined) return undefined;
    const sources = await this.sourceTextsForDocument(snapshot.loaded, document);
    const event = snapshot.scenario.eventTypes.includes(token)
      ? findDefinition(
          sources,
          token,
          /(?:eventType\s*\(\s*["']TOKEN["']|type\s*:\s*["']?TOKEN["']?)/,
        )
      : undefined;
    if (event !== undefined) return event;
    if (snapshot.scenario.operationIds.includes(token)) {
      return findDefinition(
        sources,
        token,
        /operationId\s*:\s*["']TOKEN["']|operationId\s*\(\s*["']TOKEN["']/,
      );
    }
    return undefined;
  }

  /** Return every authoring occurrence of the selected event or operation. */
  async references(document: TextDocument, position: Position): Promise<readonly Location[]> {
    const snapshot = await this.refresh();
    if (snapshot === undefined) return [];
    const token = wordAt(document, position);
    if (token === undefined || !knownScenarioSymbol(token, snapshot.scenario)) return [];
    const sources = await this.sourceTextsForDocument(snapshot.loaded, document);
    return occurrences(sources, token);
  }

  /** Rename only indexed scenario symbols; arbitrary text is never rewritten. */
  async rename(
    document: TextDocument,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | undefined> {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(newName)) return undefined;
    const snapshot = await this.refresh();
    if (snapshot === undefined) return undefined;
    const token = wordAt(document, position);
    if (token === undefined || !knownScenarioSymbol(token, snapshot.scenario)) return undefined;
    const sources = await this.sourceTextsForDocument(snapshot.loaded, document);
    const edits: Record<string, TextEdit[]> = {};
    for (const [filePath, text] of sources) {
      const fileEdits = semanticTextEdits(text, token, newName);
      if (fileEdits.length > 0) edits[pathToFileURL(filePath).toString()] = fileEdits;
    }
    return { changes: edits };
  }

  async hover(document: TextDocument, position: Position): Promise<Hover | undefined> {
    const snapshot = await this.refresh();
    if (snapshot === undefined) return undefined;
    const token = wordAt(document, position);
    if (token === undefined) return undefined;
    const event = snapshot.scenario.events.find(
      (candidate) =>
        candidate.type === token || `${candidate.boundary}:${candidate.type}` === token,
    );
    if (event !== undefined) {
      const fields = event.fields.length === 0 ? '(untyped payload)' : event.fields.join(', ');
      return {
        contents: { kind: 'markdown', value: `**event** \`${token}\`\\n\\nPayload: ${fields}` },
        range: rangeFromOffsets(
          document,
          document.offsetAt(position) - token.length,
          document.offsetAt(position),
        ),
      };
    }
    const operationIndex = snapshot.openapi.operationIdIndex;
    const operation = operationIndex?.get(token);
    if (operation !== undefined) {
      return {
        contents: {
          kind: 'markdown',
          value: `**OpenAPI operation** \`${token}\`\\n\\nRoute: \`${operation}\``,
        },
      };
    }
    return undefined;
  }

  async workspaceSymbols(query: string): Promise<readonly SymbolInformation[]> {
    const snapshot = await this.refresh();
    if (snapshot === undefined) return [];
    const sources = await this.sourceTexts(snapshot.loaded);
    const symbols: SymbolInformation[] = [];
    const matches = [
      ...snapshot.scenario.eventTypes,
      ...snapshot.scenario.operationIds,
      ...snapshot.scenario.behaviors.map((behavior) => behavior.name),
      ...(snapshot.scenario.boundaries ?? []).map((boundary) => boundary.name),
      ...(snapshot.scenario.components ?? []).map((component) => component.name),
      ...(snapshot.scenario.resources ?? []).map((resource) => resource.name),
    ]
      .filter((name, index, all) => all.indexOf(name) === index)
      .filter((name) => query === '' || name.toLowerCase().includes(query.toLowerCase()));
    for (const name of matches) {
      const locations = occurrences(sources, name);
      const first = locations[0];
      if (first === undefined) continue;
      symbols.push({
        name,
        kind:
          snapshot.scenario.eventTypes.includes(name) ||
          (snapshot.scenario.boundaries ?? []).some((boundary) => boundary.name === name) ||
          (snapshot.scenario.components ?? []).some((component) => component.name === name)
            ? SymbolKind.Event
            : SymbolKind.Method,
        location: first,
        containerName: 'Potemkin scenario',
      });
    }
    return symbols;
  }

  async dispose(): Promise<void> {
    this.documents.clear();
  }

  private async loadSnapshot(): Promise<PotemkinProjectSnapshot | undefined> {
    try {
      const configDocument = this.documents.get(this.configPath);
      const configText = configDocument?.text;
      const overrides = new Map(
        [...this.documents.values()].map((document) => [document.filePath, document.text]),
      );
      const descriptor = await loadProjectDescriptor({
        configPath: this.configPath,
        configText,
        documents: overrides,
      });
      const { openapi, loaded, scenario } = descriptor;
      const outputDirectory = path.resolve(
        this.options.outputDirectory ?? path.join(this.options.workspacePath, 'gen-src'),
      );
      const generated = await generateScenarioBindings({
        openapi,
        loaded,
        scenario,
        projectRoot: this.options.workspacePath,
        outputDirectory,
      });
      const next = { openapi, loaded, scenario, bindings: generated };
      this.snapshot = next;
      this.lastRefreshError = undefined;
      return next;
    } catch (error) {
      this.lastRefreshError = error;
      return this.snapshot;
    }
  }

  private async sourceTexts(loaded: LoadedConfig): Promise<ReadonlyMap<string, string>> {
    const configuredTypescript =
      loaded.typescript === undefined
        ? []
        : await glob(
            loaded.typescript.scan.flatMap((entry) => entry.include),
            {
              cwd: path.dirname(this.configPath),
              absolute: true,
              onlyFiles: true,
              ignore: loaded.typescript.scan.flatMap((entry) => entry.exclude ?? []),
            },
          );
    const paths = [
      this.configPath,
      ...loaded.boundaryModulePaths,
      ...loaded.componentModulePaths,
      ...loaded.globalModulePaths,
      ...loaded.useMappingModulePaths,
      ...configuredTypescript,
    ];
    const resolved = [...new Set(paths.map((file) => path.resolve(file)))];
    const entries = await Promise.all(
      resolved.map(async (file) => {
        const open = this.documents.get(file);
        if (open !== undefined) return [file, open.text] as const;
        try {
          return [file, await fs.readFile(file, 'utf8')] as const;
        } catch {
          return undefined;
        }
      }),
    );
    return new Map(
      entries.filter((entry): entry is readonly [string, string] => entry !== undefined),
    );
  }

  private async sourceTextsForDocument(
    loaded: LoadedConfig,
    document: TextDocument,
  ): Promise<ReadonlyMap<string, string>> {
    const sources = new Map(await this.sourceTexts(loaded));
    sources.set(uriToPath(document.uri), document.getText());
    return sources;
  }

  private async typescriptDiagnostics(
    document: TextDocument,
    snapshot: PotemkinProjectSnapshot,
  ): Promise<readonly Diagnostic[]> {
    const sourceTexts = new Map(await this.sourceTexts(snapshot.loaded));
    sourceTexts.set(
      document.uri.startsWith('file:') ? uriToPath(document.uri) : document.uri,
      document.getText(),
    );
    for (const file of [snapshot.bindings.outputFile, snapshot.bindings.sdkOutputFile]) {
      const text = await readOptional(file);
      if (text !== undefined) sourceTexts.set(file, text);
    }
    const fileNames = [...sourceTexts.keys()].filter((file) => /\.tsx?$|\.d\.ts$/.test(file));
    const compilerOptions: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      baseUrl: this.options.workspacePath,
    };
    const resolvedSdk = ts.resolveModuleName(
      'potemkin/sdk',
      uriToPath(document.uri),
      compilerOptions,
      ts.sys,
    ).resolvedModule;
    if (resolvedSdk === undefined) return [];
    const versions = new Map(fileNames.map((file) => [file, '1'] as const));
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => compilerOptions,
      getScriptFileNames: () => fileNames,
      getScriptVersion: (fileName) => versions.get(fileName) ?? '1',
      getScriptSnapshot: (fileName) => {
        const text = sourceTexts.get(fileName) ?? ts.sys.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.options.workspacePath,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
    };
    const languageService = ts.createLanguageService(host);
    return languageService
      .getSemanticDiagnostics(uriToPath(document.uri))
      .map((diagnostic) => typeScriptDiagnostic(document, diagnostic));
  }
}

function yamlDiagnostics(document: TextDocument, configPath: string): readonly Diagnostic[] {
  const parsed = parseDocument(document.getText());
  const diagnostics = parsed.errors.map((error) =>
    diagnosticAtOffset(document, error.message, error.pos?.[0] ?? 0),
  );
  if (diagnostics.length > 0) return diagnostics;
  try {
    const value = parsed.toJS();
    if (path.resolve(uriToPath(document.uri)) === path.resolve(configPath)) {
      validatePotemkinConfig(value, { source: document.uri });
    } else if (isRecord(value) && value.kind === 'component') {
      parseComponent(document.getText());
    } else if (isRecord(value) && Array.isArray(value.use)) {
      parseUseMapping(document.getText());
    } else if (isRecord(value) && value.boundary !== undefined) {
      parseYaml(document.getText());
    } else {
      validateGlobalConfig(value);
    }
  } catch (error) {
    return [diagnosticAtOffset(document, errorMessage(error), 0)];
  }
  return [];
}

function scenarioYamlDiagnostics(
  document: TextDocument,
  scenario: ScenarioModel,
): readonly Diagnostic[] {
  const parsed = parseDocument(document.getText());
  let value: unknown;
  try {
    value = parsed.toJS();
  } catch {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  visitYaml(value, (key, valueAtKey) => {
    if (typeof valueAtKey !== 'string') return;
    if (key === 'contract_path' && !scenario.paths.includes(valueAtKey)) {
      diagnostics.push(
        valueDiagnostic(document, valueAtKey, `Unknown OpenAPI path "${valueAtKey}"`),
      );
    }
    if (key === 'operationId' && !scenario.operationIds.includes(valueAtKey)) {
      diagnostics.push(
        valueDiagnostic(document, valueAtKey, `Unknown OpenAPI operationId "${valueAtKey}"`),
      );
    }
    const schemaName = valueAtKey.startsWith('#/components/schemas/')
      ? valueAtKey.slice('#/components/schemas/'.length)
      : valueAtKey;
    if (
      SCHEMA_VALUE_KEYS.has(key) &&
      scenario.schemas.length > 0 &&
      !scenario.schemas.includes(schemaName)
    ) {
      diagnostics.push(
        valueDiagnostic(document, valueAtKey, `Unknown OpenAPI schema "${valueAtKey}"`),
      );
    }
    if (
      COMPONENT_VALUE_KEYS.has(key) &&
      scenario.components !== undefined &&
      scenario.components.length > 0 &&
      !scenario.components.some((component) => component.name === valueAtKey)
    ) {
      diagnostics.push(
        valueDiagnostic(document, valueAtKey, `Unknown scenario component "${valueAtKey}"`),
      );
    }
    if (
      RESOURCE_VALUE_KEYS.has(key) &&
      scenario.resources !== undefined &&
      scenario.resources.length > 0 &&
      !scenario.resources.some((resource) => resource.name === valueAtKey)
    ) {
      diagnostics.push(
        valueDiagnostic(document, valueAtKey, `Unknown scenario resource "${valueAtKey}"`),
      );
    }
    if (EVENT_VALUE_KEYS.has(key) && key !== 'type' && scenario.eventTypes.length > 0) {
      const known =
        scenario.eventSelectors.includes(valueAtKey) || scenario.eventTypes.includes(valueAtKey);
      if (!known)
        diagnostics.push(
          valueDiagnostic(document, valueAtKey, `Unknown scenario event "${valueAtKey}"`),
        );
    }
  });
  return diagnostics;
}

async function generatedSchemaDiagnostics(
  document: TextDocument,
  schemaFile: string,
): Promise<readonly Diagnostic[]> {
  let schema: unknown;
  try {
    schema = JSON.parse(await fs.readFile(schemaFile, 'utf8'));
  } catch {
    return [];
  }
  const parsed = parseDocument(document.getText());
  if (parsed.errors.length > 0) return [];
  let value: unknown;
  try {
    value = parsed.toJS();
  } catch {
    return [];
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(
    schema as Record<string, unknown>,
  );
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 8).map((error) => {
    const property = error.instancePath.split('/').filter(Boolean).at(-1);
    const searched =
      property === undefined ? undefined : String(valueAtPath(value, error.instancePath));
    const offset =
      searched === undefined || searched === 'undefined' ? 0 : document.getText().indexOf(searched);
    return diagnosticAtOffset(
      document,
      `Schema: ${error.message ?? 'invalid value'}`,
      offset < 0 ? 0 : offset,
      searched === undefined || searched === 'undefined' ? 1 : searched.length,
    );
  });
}

function valueAtPath(value: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (Array.isArray(current)) return current[Number(segment)];
      if (isRecord(current)) return current[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
      return undefined;
    }, value);
}

function typescriptEventDiagnostics(
  document: TextDocument,
  scenario: ScenarioModel,
): readonly Diagnostic[] {
  if (scenario.eventTypes.length === 0) return [];
  const source = ts.createSourceFile(
    uriToPath(document.uri),
    document.getText(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics: Diagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      const candidates =
        name === 'eventType'
          ? [node.arguments[0]]
          : name === 'eventReference'
            ? [node.arguments[1]]
            : [];
      for (const candidate of candidates) {
        if (!ts.isStringLiteral(candidate) || scenario.eventTypes.includes(candidate.text))
          continue;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          message: `Unknown scenario event "${candidate.text}"`,
          range: rangeFromOffsets(document, candidate.getStart(source), candidate.getEnd()),
          source: 'potemkin',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return diagnostics;
}

function yamlCompletions(
  line: string,
  scenario: ScenarioModel,
  configuration: boolean,
  documentText = line,
  lineNumber = 0,
): readonly CompletionItem[] {
  const key = line.match(/(?:^|\s)([A-Za-z_]+):\s*[^#]*$/)?.[1];
  const values =
    key === 'contract_path'
      ? scenario.paths
      : key === 'operationId'
        ? scenario.operationIds
        : key !== undefined && SCHEMA_VALUE_KEYS.has(key)
          ? scenario.schemas
          : key !== undefined && COMPONENT_VALUE_KEYS.has(key)
            ? (scenario.components?.map((component) => component.name) ?? [])
            : key !== undefined && RESOURCE_VALUE_KEYS.has(key)
              ? (scenario.resources?.map((resource) => resource.name) ?? [])
              : key !== undefined && EVENT_VALUE_KEYS.has(key)
                ? scenario.eventSelectors
                : key === 'payload_template'
                  ? [...new Set(scenario.events.flatMap((event) => event.fields))]
                  : undefined;
  if (values !== undefined)
    return values.map((label) => ({ label, kind: CompletionItemKind.Value }));
  const keys =
    line.trim() === ''
      ? configuration
        ? configurationKeysAt(documentText, lineNumber)
        : YAML_ROOT_KEYS
      : [];
  return keys.map((label) => ({ label, kind: CompletionItemKind.Property }));
}

function configurationKeysAt(documentText: string, lineNumber: number): readonly string[] {
  const lines = documentText.split(/\r?\n/);
  const currentIndent = lines[lineNumber]?.match(/^\s*/)?.[0].length ?? 0;
  const parents = new Map<number, string>();
  for (const sourceLine of lines.slice(0, lineNumber)) {
    const match = sourceLine.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):(?:\s|$)/);
    if (match === null) continue;
    const indent = match[1]!.length;
    if (indent < currentIndent) parents.set(indent, match[2]!);
    else if (indent <= currentIndent) parents.delete(indent);
  }
  const parent = [...parents.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, key]) => key)
    .join('.');
  const keys: Record<string, readonly string[]> = {
    '': CONFIG_ROOT_KEYS,
    plugin: [
      'engine',
      'controlPort',
      'resilience',
      'healthProbe',
      'discovery',
      'circuitBreaker',
      'auth',
    ],
    'plugin.engine': ['url', 'timeoutMs'],
    'plugin.resilience': ['maxRetries', 'backoffMs'],
    'plugin.healthProbe': ['initialMs', 'stableMs', 'path'],
    'plugin.discovery': ['refreshOnFailureMs', 'ttlSeconds'],
    'plugin.circuitBreaker': ['failureRate', 'waitMs'],
    'plugin.auth': ['mode', 'algorithm', 'secret', 'jwks', 'jwksUrl', 'realm'],
    typescript: ['scan', 'watchIntervalMs'],
    seeds: ['description', 'request', 'base', 'patches'],
    'seeds.request': ['method', 'path'],
    workflow: ['ids'],
    overlay: ['patches'],
    governance: ['report', 'successCriterion'],
    'governance.report': ['format', 'successCriteria'],
    'governance.report.successCriteria': ['minCoverage', 'excludedEndpoints'],
  };
  return keys[parent] ?? [];
}

function typescriptCompletions(line: string, scenario: ScenarioModel): readonly CompletionItem[] {
  if (
    /eventType\s*\(\s*["'][^"']*$/.test(line) ||
    /eventReference\([^,]*,\s*["'][^"']*$/.test(line)
  ) {
    return scenario.eventTypes.map((label) => ({ label, kind: CompletionItemKind.EnumMember }));
  }
  if (/(?:operationId|operation)\s*\(\s*["'][^"']*$/.test(line)) {
    return scenario.operationIds.map((label) => ({ label, kind: CompletionItemKind.Reference }));
  }
  if (/schemaReference\s*\(\s*["'][^"']*$/.test(line)) {
    return scenario.schemas.map((label) => ({ label, kind: CompletionItemKind.Reference }));
  }
  if (/componentName\s*\(\s*["'][^"']*$/.test(line)) {
    return (scenario.components ?? []).map((component) => ({
      label: component.name,
      kind: CompletionItemKind.Reference,
    }));
  }
  if (/resourceName\s*\(\s*["'][^"']*$/.test(line)) {
    return (scenario.resources ?? []).map((resource) => ({
      label: resource.name,
      kind: CompletionItemKind.Reference,
    }));
  }
  if (/behaviorName\s*\(\s*["'][^"']*$/.test(line)) {
    return scenario.behaviors.map((behavior) => ({
      label: behavior.name,
      kind: CompletionItemKind.Reference,
    }));
  }
  if (/boundaryName\s*\(\s*["'][^"']*$/.test(line)) {
    return (scenario.boundaries ?? []).map((boundary) => ({
      label: boundary.name,
      kind: CompletionItemKind.Reference,
    }));
  }
  return [];
}

function visitYaml(value: unknown, callback: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitYaml(entry, callback));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    callback(key, child);
    visitYaml(child, callback);
  }
}

function findDefinition(
  sources: ReadonlyMap<string, string>,
  token: string,
  pattern: RegExp,
): Location | undefined {
  const expression = new RegExp(
    pattern.source.replaceAll('TOKEN', escapeRegExp(token)),
    pattern.flags,
  );
  for (const [filePath, text] of sources) {
    const match = expression.exec(text);
    if (match === null) continue;
    const start = match.index + match[0].lastIndexOf(token);
    return {
      uri: pathToFileURL(filePath).toString(),
      range: rangeFromOffsetsText(text, start, start + token.length),
    };
  }
  return undefined;
}

function knownScenarioSymbol(token: string, scenario: ScenarioModel): boolean {
  return (
    scenario.eventTypes.includes(token) ||
    scenario.operationIds.includes(token) ||
    scenario.behaviors.some((behavior) => behavior.name === token) ||
    scenario.boundaries?.some((boundary) => boundary.name === token) === true ||
    scenario.components?.some((component) => component.name === token) === true ||
    scenario.resources?.some((resource) => resource.name === token) === true
  );
}

function occurrences(sources: ReadonlyMap<string, string>, token: string): readonly Location[] {
  const escaped = escapeRegExp(token);
  const expression = new RegExp(`(?<![A-Za-z0-9_:-])${escaped}(?![A-Za-z0-9_:-])`, 'g');
  const result: Location[] = [];
  for (const [filePath, text] of sources) {
    for (const match of text.matchAll(expression)) {
      const start = match.index ?? 0;
      result.push({
        uri: pathToFileURL(filePath).toString(),
        range: rangeFromOffsetsText(text, start, start + token.length),
      });
    }
  }
  return result;
}

function semanticTextEdits(text: string, token: string, replacement: string): TextEdit[] {
  return occurrences(new Map([['file:///current', text]]), token).map((location) => ({
    range: location.range,
    newText: replacement,
  }));
}

function wordAt(document: TextDocument, position: Position): string | undefined {
  const offset = document.offsetAt(position);
  const text = document.getText();
  const left = text.slice(0, offset).match(/[A-Za-z0-9_:-]+$/)?.[0] ?? '';
  const right = text.slice(offset).match(/^[A-Za-z0-9_:-]*/)?.[0] ?? '';
  const word = `${left}${right}`;
  return word === '' ? undefined : word;
}

function valueDiagnostic(document: TextDocument, value: string, message: string): Diagnostic {
  const offset = document.getText().indexOf(value);
  return diagnosticAtOffset(document, message, offset < 0 ? 0 : offset, value.length);
}

function diagnosticAtOffset(
  document: TextDocument,
  message: string,
  offset: number,
  length = 1,
): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    message,
    range: rangeFromOffsets(document, Math.max(0, offset), Math.max(0, offset + length)),
    source: 'potemkin',
  };
}

function refreshDiagnostic(error: unknown): readonly Diagnostic[] {
  return error === undefined
    ? []
    : [
        {
          severity: DiagnosticSeverity.Error,
          message: errorMessage(error),
          range: zeroRange(),
          source: 'potemkin',
        },
      ];
}

function typeScriptDiagnostic(document: TextDocument, diagnostic: ts.Diagnostic): Diagnostic {
  const start = diagnostic.start ?? 0;
  const length = diagnostic.length ?? 1;
  return {
    severity: DiagnosticSeverity.Error,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    range: rangeFromOffsets(document, start, start + length),
    source: 'typescript',
  };
}

function deduplicateDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  const unique = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.source}:${diagnostic.message}:${diagnostic.range.start.line}:${diagnostic.range.start.character}`;
    unique.set(key, diagnostic);
  }
  return [...unique.values()];
}

function rangeFromOffsets(document: TextDocument, start: number, end: number): Range {
  return { start: document.positionAt(start), end: document.positionAt(end) };
}

function rangeFromOffsetsText(text: string, start: number, end: number): Range {
  const document = { positionAt: (offset: number): Position => positionAt(text, offset) };
  return { start: document.positionAt(start), end: document.positionAt(end) };
}

function positionAt(text: string, offset: number): Position {
  const prefix = text.slice(0, offset).split('\n');
  return { line: prefix.length - 1, character: prefix[prefix.length - 1].length };
}

function zeroRange(): Range {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}

function languageFor(uri: string, languageId: string): AuthoringLanguage {
  if (languageId === 'typescript' || languageId === 'typescriptreact') return 'typescript';
  return uri.endsWith('.ts') || uri.endsWith('.tsx') ? 'typescript' : 'yaml';
}

function resolveConfigPath(workspacePath: string, configured?: string): string {
  const candidate = path.resolve(workspacePath, configured ?? 'potemkin.yml');
  return candidate.endsWith('.yml') || candidate.endsWith('.yaml')
    ? candidate
    : path.join(candidate, 'potemkin.yml');
}

function uriToPath(uri: string): string {
  return uri.startsWith('file:') ? fileURLToPath(uri) : path.resolve(uri);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function calledName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
