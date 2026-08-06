import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parse } from 'yaml';

import { BootError } from '../errors.js';
import type { OpenApiDoc, OpenApiLoadObservability } from '../contract/loader.js';
import { loadOpenApiDocuments } from '../contract/loader.js';
import { isRecord } from '../contracts/value.js';

export async function loadConfiguredOpenApi(
  configPath: string,
  fallback?: OpenApiDoc,
  observability: OpenApiLoadObservability = {},
  configTextOverride?: string,
): Promise<OpenApiDoc> {
  let configText: string;
  if (configTextOverride !== undefined) configText = configTextOverride;
  else {
    try {
      configText = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      throw new BootError(
        'BOOT_ERR_CONTRACT_LOAD',
        `Cannot read potemkin configuration at ${configPath}: ${errorMessage(error)}`,
        { path: configPath, reason: errorMessage(error) },
      );
    }
  }

  let config: unknown;
  try {
    config = parseLegacyYaml(configText);
  } catch (error) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `Cannot parse potemkin configuration at ${configPath}: ${errorMessage(error)}`,
      { path: configPath, reason: errorMessage(error) },
    );
  }
  const configRecord = asRecord(config);
  const configuredPaths = stringArray(configRecord['openapi']);
  if (configuredPaths !== undefined) {
    try {
      return await loadOpenApiDocuments(
        configuredPaths,
        path.dirname(path.resolve(configPath)),
        observability,
      );
    } catch (error) {
      throw asContractLoadError(configPath, error);
    }
  }
  const specmatic = configRecord['specmatic'];
  if (typeof specmatic !== 'string') {
    if (fallback !== undefined) return fallback;
    throw new BootError(
      'BOOT_ERR_CONTRACT_LOAD',
      `Cannot discover OpenAPI documents from ${configPath}: specmatic must be a path`,
      { path: configPath, field: 'specmatic' },
    );
  }
  const specmaticPath = path.resolve(path.dirname(path.resolve(configPath)), specmatic);
  let specmaticText: string;
  try {
    specmaticText = await fs.readFile(specmaticPath, 'utf8');
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw asContractLoadError(specmaticPath, error);
  }
  let documentValue: unknown;
  try {
    documentValue = parseLegacyYaml(specmaticText);
  } catch (error) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `Cannot parse Specmatic configuration at ${specmaticPath}: ${errorMessage(error)}`,
      { path: specmaticPath, reason: errorMessage(error) },
    );
  }
  const document = asRecord(documentValue);
  const service = asRecord(asRecord(document['systemUnderTest'])['service']);
  const definitions = Array.isArray(service['definitions']) ? service['definitions'] : [];
  const paths: string[] = [];
  for (const definitionValue of definitions) {
    const definition = asRecord(definitionValue);
    const fileSystem = asRecord(asRecord(definition['source'])['fileSystem']);
    const directory = typeof fileSystem['directory'] === 'string' ? fileSystem['directory'] : '.';
    const specs = Array.isArray(definition['specs']) ? definition['specs'] : [];
    for (const specValue of specs) {
      const spec = asRecord(specValue);
      if (typeof spec['path'] === 'string')
        paths.push(path.resolve(path.dirname(specmaticPath), directory, spec['path']));
    }
  }
  if (paths.length === 0)
    throw new BootError(
      'BOOT_ERR_CONTRACT_LOAD',
      `Cannot discover OpenAPI documents from ${specmaticPath}: no specs found`,
      { path: specmaticPath },
    );
  try {
    return await loadOpenApiDocuments(paths, path.dirname(specmaticPath), observability);
  } catch (error) {
    throw asContractLoadError(specmaticPath, error);
  }
}

function asContractLoadError(pathname: string, error: unknown): BootError {
  if (error instanceof BootError) return error;
  return new BootError(
    'BOOT_ERR_CONTRACT_LOAD',
    `Cannot load OpenAPI documents from ${pathname}: ${errorMessage(error)}`,
    { path: pathname, reason: errorMessage(error) },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the configured-file parser compatible with the former js-yaml loader.
 * The core schema preserves its YAML 1.2 scalar rules, while these options
 * retain the merge-key and implicit timestamp behavior used by js-yaml.
 */
function parseLegacyYaml(source: string): unknown {
  return parse(source, {
    schema: 'core',
    merge: true,
    customTags: ['timestamp'],
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}
