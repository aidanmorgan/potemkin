/**
 * Integration test: the global-config compile path is fail-fast.
 *
 * An unknown top-level key in a global module must abort compilation with a
 * BootError instead of being silently dropped. This guards against the audited
 * regression where unhandled blocks (versioning/security_headers/...) were
 * parsed away to nothing.
 */

import { compileDsl } from '../../src/dsl/parser.js';
import { BootError } from '../../src/errors.js';

const BOUNDARY_YAML = `
boundary: Widget
contract_path: /widgets
behaviors: []
`;

describe('global config fail-fast (compile path)', () => {
  it('throws BootError when a global module declares an unknown top-level key', async () => {
    const globalYaml = 'mystery_block:\n  foo: bar\n';
    await expect(
      compileDsl([{ name: 'widget', yaml: BOUNDARY_YAML }], globalYaml),
    ).rejects.toBeInstanceOf(BootError);
  });

  it('still compiles cleanly when every global key is supported', async () => {
    const globalYaml = [
      'versioning:',
      '  enabled: true',
      '  versions:',
      '    - version: v1',
      '      prefix: /v1',
      '      default: true',
      'security_headers:',
      '  enabled: true',
      '  nosniff: true',
    ].join('\n');
    const dsl = await compileDsl([{ name: 'widget', yaml: BOUNDARY_YAML }], globalYaml);
    expect(dsl.versioning?.enabled).toBe(true);
    expect(dsl.securityHeaders?.nosniff).toBe(true);
  });
});
