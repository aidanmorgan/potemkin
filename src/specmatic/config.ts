/**
 * Specmatic config parser — reads specmatic.yaml or specmatic.json.
 *
 * Supported top-level shapes:
 *   1. New sources[] format:
 *      sources:
 *        - provider: ...
 *          repository: ...
 *          specifications:
 *            - path/to/spec.yaml
 *
 *   2. Legacy flat format:
 *      contracts:
 *        - path/to/spec.yaml
 *      stubs:          (or mocks:)
 *        - path/to/stub.json
 *
 * Both normalise to { contracts: string[], stubs: string[] }.
 */

import yaml from 'js-yaml';

export interface SpecmaticConfig {
  readonly contracts: string[];
  readonly stubs: string[];
}

/**
 * Parse a specmatic.yaml/json file content.
 *
 * @param yamlOrJson - Raw YAML/JSON string, or already-parsed object.
 * @returns Normalised { contracts, stubs } config.
 */
export function loadSpecmaticConfig(yamlOrJson: string | object): SpecmaticConfig {
  let raw: unknown;

  if (typeof yamlOrJson === 'string') {
    try {
      raw = yaml.load(yamlOrJson);
    } catch {
      raw = {};
    }
  } else {
    raw = yamlOrJson;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { contracts: [], stubs: [] };
  }

  const doc = raw as Record<string, unknown>;

  // Shape 1: sources[] array
  if (Array.isArray(doc['sources'])) {
    const contracts: string[] = [];
    for (const source of doc['sources'] as unknown[]) {
      if (typeof source !== 'object' || source === null) continue;
      const src = source as Record<string, unknown>;
      if (Array.isArray(src['specifications'])) {
        for (const spec of src['specifications'] as unknown[]) {
          if (typeof spec === 'string') contracts.push(spec);
        }
      }
    }
    return { contracts, stubs: [] };
  }

  // Shape 2: flat contracts[] + stubs[]/mocks[]
  const contracts: string[] = normaliseStringArray(doc['contracts']);
  const stubs: string[] = [
    ...normaliseStringArray(doc['stubs']),
    ...normaliseStringArray(doc['mocks']),
  ];

  return { contracts, stubs };
}

function normaliseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
