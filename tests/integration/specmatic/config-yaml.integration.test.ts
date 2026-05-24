/**
 * config-yaml.integration.test.ts
 *
 * Tests for loadSpecmaticConfig — parses specmatic.yaml and specmatic.json
 * in both the new sources[] format and the legacy contracts[]/stubs[] format.
 */

import { loadSpecmaticConfig } from '../../../src/specmatic/config.js';

describe('config-yaml.integration', () => {
  // ── sources[] format (new) ─────────────────────────────────────────────────

  it('parses sources[] format YAML and extracts contracts', () => {
    const yaml = `
sources:
  - provider: git
    repository: https://example.com/specs.git
    specifications:
      - openapi/banking.yaml
      - openapi/payments.yaml
`;
    const config = loadSpecmaticConfig(yaml);
    expect(config.contracts).toEqual(['openapi/banking.yaml', 'openapi/payments.yaml']);
    expect(config.stubs).toEqual([]);
  });

  it('parses sources[] format with multiple sources (specifications flattened)', () => {
    const yaml = `
sources:
  - provider: git
    specifications:
      - api/one.yaml
  - provider: local
    specifications:
      - api/two.yaml
      - api/three.yaml
`;
    const config = loadSpecmaticConfig(yaml);
    expect(config.contracts).toEqual(['api/one.yaml', 'api/two.yaml', 'api/three.yaml']);
  });

  // ── legacy flat format (contracts[] + stubs[]) ─────────────────────────────

  it('parses legacy contracts[] + stubs[] YAML format', () => {
    const yaml = `
contracts:
  - openapi/v1.yaml
  - openapi/v2.yaml
stubs:
  - stubs/stub1.json
  - stubs/stub2.json
`;
    const config = loadSpecmaticConfig(yaml);
    expect(config.contracts).toEqual(['openapi/v1.yaml', 'openapi/v2.yaml']);
    expect(config.stubs).toEqual(['stubs/stub1.json', 'stubs/stub2.json']);
  });

  it('parses legacy mocks[] alias (equivalent to stubs[])', () => {
    const yaml = `
contracts:
  - openapi/api.yaml
mocks:
  - mocks/mock1.json
`;
    const config = loadSpecmaticConfig(yaml);
    expect(config.contracts).toEqual(['openapi/api.yaml']);
    expect(config.stubs).toEqual(['mocks/mock1.json']);
  });

  it('merges stubs[] and mocks[] when both present', () => {
    const yaml = `
contracts: []
stubs:
  - a.json
mocks:
  - b.json
`;
    const config = loadSpecmaticConfig(yaml);
    expect(config.stubs).toEqual(['a.json', 'b.json']);
  });

  // ── JSON format ────────────────────────────────────────────────────────────

  it('parses specmatic.json in legacy format (object input)', () => {
    const jsonConfig = {
      contracts: ['openapi/banking.yaml'],
      stubs: ['stubs/banking_stub.json'],
    };
    const config = loadSpecmaticConfig(jsonConfig);
    expect(config.contracts).toEqual(['openapi/banking.yaml']);
    expect(config.stubs).toEqual(['stubs/banking_stub.json']);
  });

  it('parses specmatic.json in sources[] format (JSON string)', () => {
    const jsonStr = JSON.stringify({
      sources: [
        { provider: 'local', specifications: ['spec.yaml'] },
      ],
    });
    const config = loadSpecmaticConfig(jsonStr);
    expect(config.contracts).toEqual(['spec.yaml']);
    expect(config.stubs).toEqual([]);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('malformed YAML string returns empty config (no throw)', () => {
    // js-yaml falls back to a string value on certain malformed inputs; loadSpecmaticConfig
    // handles non-object result gracefully by returning empty config
    const result = loadSpecmaticConfig('{invalid: yaml: content:');
    expect(result.contracts).toEqual([]);
    expect(result.stubs).toEqual([]);
  });

  it('empty YAML string → empty config', () => {
    const config = loadSpecmaticConfig('');
    expect(config.contracts).toEqual([]);
    expect(config.stubs).toEqual([]);
  });

  it('YAML with no contracts or sources → empty contracts array', () => {
    const config = loadSpecmaticConfig('version: 1');
    expect(config.contracts).toEqual([]);
    expect(config.stubs).toEqual([]);
  });

  it('non-string entries in contracts[] array are filtered out', () => {
    const config = loadSpecmaticConfig({
      contracts: ['real.yaml', 42, null, 'also-real.yaml'],
      stubs: [],
    });
    expect(config.contracts).toEqual(['real.yaml', 'also-real.yaml']);
  });
});
