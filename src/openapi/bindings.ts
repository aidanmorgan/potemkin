import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Eta } from 'eta';
import openapiTS, { astToString, type OpenAPI3 } from 'openapi-typescript';

import type { OpenApiDoc } from '../contract/loader.js';
import { asRecord, isRecord } from '../contracts/value.js';
import type { ScenarioFieldType, ScenarioModel } from './scenarioModel.js';

/** Options shared by the CLI, language-service plugin, and future editor adapters. */
export interface OpenApiBindingOptions {
  /** Directory containing generated sources. Defaults to `<projectRoot>/gen-src`. */
  readonly outputDirectory?: string;
  /** Ambient module name imported by authoring code. */
  readonly moduleName?: string;
  /** Project root used to resolve external `$ref` files. */
  readonly projectRoot?: string;
  /** Combined OpenAPI/YAML/TypeScript model used to expose scenario event types. */
  readonly scenario?: ScenarioModel;
}

export interface GeneratedOpenApiBindings {
  readonly outputFile: string;
  readonly sdkOutputFile: string;
  readonly hash: string;
  readonly changed: boolean;
}

const GENERATED_FILE = 'openapi.d.ts';
const GENERATED_SDK_FILE = 'potemkin-sdk.d.ts';
const DEFAULT_MODULE_NAME = 'potemkin/openapi';
const TEMPLATE_FILE = path.join(__dirname, 'templates', 'openapi.d.ts.eta');
const SDK_TEMPLATE_FILE = path.join(__dirname, 'templates', 'potemkin-sdk.d.ts.eta');

/**
 * Generate IDE-friendly OpenAPI types from the original contract document.
 *
 * The generated file is declaration-only and is intentionally not part of the
 * runtime model. It is safe to regenerate on every config reload because writes
 * are content-addressed and skipped when the result is unchanged.
 */
export async function generateOpenApiBindings(
  document: OpenApiDoc,
  options: OpenApiBindingOptions = {},
): Promise<GeneratedOpenApiBindings> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(projectRoot, 'gen-src'),
  );
  const moduleName = options.moduleName ?? DEFAULT_MODULE_NAME;
  const source = document.source ?? document.raw;
  const sourcePath = document.sourcePaths?.length === 1 ? document.sourcePaths[0] : undefined;
  const generatorInput = sourcePath
    ? pathToFileURL(sourcePath)
    : asOpenApiTypescriptDocument(source);
  const nodes = await openapiTS(generatorInput, {
    cwd: sourcePath ? path.dirname(sourcePath) : projectRoot,
    silent: true,
    alphabetize: true,
    immutable: true,
  });
  const generatedDeclarations = astToString(nodes).trim();
  const template = await fs.readFile(TEMPLATE_FILE, 'utf8');
  const sdkTemplate = await fs.readFile(SDK_TEMPLATE_FILE, 'utf8');
  const content = new Eta().renderString(template, {
    moduleNameLiteral: JSON.stringify(moduleName),
    declarations: generatedDeclarations,
    events: eventTemplateModel(options.scenario),
    indent,
  });
  const sdkContent = new Eta().renderString(sdkTemplate, {
    events: eventTemplateModel(options.scenario),
    openapiModuleNameLiteral: JSON.stringify(moduleName),
    paths: [
      ...new Set([...(options.scenario?.paths ?? []), ...Object.keys(document.paths)].sort()),
    ].map((value) => ({
      literal: JSON.stringify(value),
    })),
    schemas: [
      ...new Set([...(options.scenario?.schemas ?? []), ...componentSchemaNames(document)].sort()),
    ].map((value) => ({
      literal: JSON.stringify(value),
    })),
    operations: operationTemplateModel(document, options.scenario).map((operation) => ({
      nameLiteral: JSON.stringify(operation.operationId),
      pathLiteral: JSON.stringify(operation.path),
      methodLiteral: JSON.stringify(operation.method),
      parameterLiterals: operation.parameters.map((parameter) => JSON.stringify(parameter)),
    })),
  });
  const hash = createHash('sha256').update(content).update(sdkContent).digest('hex');
  const outputFile = path.join(outputDirectory, GENERATED_FILE);
  const sdkOutputFile = path.join(outputDirectory, GENERATED_SDK_FILE);
  const [previous, previousSdk] = await Promise.all([
    readOptional(outputFile),
    readOptional(sdkOutputFile),
  ]);
  if (previous === content && previousSdk === sdkContent) {
    return { outputFile, sdkOutputFile, hash, changed: false };
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  await writeGeneratedFile(outputFile, content);
  await writeGeneratedFile(sdkOutputFile, sdkContent);
  return { outputFile, sdkOutputFile, hash, changed: true };
}

function componentSchemaNames(document: OpenApiDoc): readonly string[] {
  const source = document.source ?? document.raw;
  const sourceRecord = asRecord(source);
  const components = sourceRecord?.['components'];
  const componentRecord = asRecord(components);
  const schemas = componentRecord?.['schemas'];
  const schemaRecord = asRecord(schemas);
  return schemaRecord === undefined ? [] : Object.keys(schemaRecord);
}

function asOpenApiTypescriptDocument(value: unknown): OpenAPI3 {
  if (!isOpenApiTypescriptDocument(value)) {
    throw new TypeError('OpenAPI TypeScript generation requires an OpenAPI 3 document');
  }
  return value;
}

function isOpenApiTypescriptDocument(value: unknown): value is OpenAPI3 {
  if (!isRecord(value) || typeof value['openapi'] !== 'string') return false;
  const info = asRecord(value['info']);
  return (
    info !== undefined && typeof info['title'] === 'string' && typeof info['version'] === 'string'
  );
}

function operationTemplateModel(
  document: OpenApiDoc,
  scenario: ScenarioModel | undefined,
): readonly {
  readonly operationId: string;
  readonly path: string;
  readonly method: string;
  readonly parameters: readonly string[];
}[] {
  if (scenario?.operations !== undefined && scenario.operations.length > 0) {
    return scenario.operations;
  }
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item).flatMap(([method, operation]) =>
      operation?.operationId === undefined
        ? []
        : [
            {
              operationId: operation.operationId,
              path,
              method: method.toUpperCase(),
              parameters: operation.parameters?.map((parameter) => parameter.name) ?? [],
            },
          ],
    ),
  );
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function writeGeneratedFile(file: string, content: string): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, content, 'utf8');
  await fs.rename(temporaryFile, file);
}

function eventTemplateModel(scenario: ScenarioModel | undefined): readonly unknown[] {
  const byIdentity = new Map<string, ScenarioModel['events'][number]>();
  for (const event of scenario?.events ?? []) {
    const identity = `${event.boundary}:${event.type}`;
    const previous = byIdentity.get(identity);
    byIdentity.set(identity, {
      boundary: previous?.boundary ?? event.boundary,
      type: event.type,
      fields: [...new Set([...(previous?.fields ?? []), ...event.fields])].sort(),
      fieldTypes: { ...previous?.fieldTypes, ...event.fieldTypes },
      ...((previous?.schemaRef ?? event.schemaRef)
        ? { schemaRef: previous?.schemaRef ?? event.schemaRef }
        : {}),
    });
  }
  return [...byIdentity.values()].flatMap((event) => {
    const schemaNameLiteral = event.schemaRef?.startsWith('#/components/schemas/')
      ? JSON.stringify(event.schemaRef.slice('#/components/schemas/'.length))
      : undefined;
    const fields = event.fields.map((field) => ({
      literal: JSON.stringify(field),
      type: typeScriptType(event.fieldTypes?.[field]),
    }));
    const names =
      event.boundary === '' || event.boundary === event.type
        ? [event.type]
        : [event.type, `${event.boundary}:${event.type}`];
    return names.map((name) => ({
      typeLiteral: JSON.stringify(name),
      schemaNameLiteral,
      fields,
    }));
  });
}

function typeScriptType(type: ScenarioFieldType | undefined): string {
  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
      return type;
    case 'object':
      return 'Record<string, unknown>';
    case 'array':
      return 'readonly unknown[]';
    default:
      return 'unknown';
  }
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join('\n');
}
