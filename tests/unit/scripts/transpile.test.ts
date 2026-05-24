import { transpileScript } from '../../../src/scripts/transpile.js';
import { BootError } from '../../../src/errors.js';

describe('transpileScript', () => {
  it('transpiles valid TypeScript to CJS JavaScript (happy path)', () => {
    const code = `
      export default function(ctx: { state: { value: number } }): number {
        return ctx.state.value * 2;
      }
    `;
    const result = transpileScript('doubleValue', 'TestBoundary', code);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Should have removed TypeScript syntax and be valid JS
    expect(result).not.toContain(': { state:');
    expect(result).toContain('function');
  });

  it('transpiles TypeScript with type annotations and interfaces', () => {
    const code = `
      interface Ctx { command: { payload: { amount: number } } }
      export default (ctx: Ctx): boolean => ctx.command.payload.amount > 100;
    `;
    const result = transpileScript('isHighValue', 'TestBoundary', code);
    expect(typeof result).toBe('string');
    expect(result).not.toContain('interface Ctx');
  });

  it('throws BootError with BOOT_ERR_SCRIPT_SYNTAX on TypeScript syntax error', () => {
    const badCode = `export default function(ctx) { const x = @ };`;
    expect(() => transpileScript('badScript', 'TestBoundary', badCode))
      .toThrow(BootError);
    try {
      transpileScript('badScript', 'TestBoundary', badCode);
    } catch (err) {
      expect(err instanceof BootError).toBe(true);
      expect((err as BootError).code).toBe('BOOT_ERR_SCRIPT_SYNTAX');
      const details = (err as BootError).details as Record<string, unknown>;
      expect(details['scriptName']).toBe('badScript');
      expect(details['boundary']).toBe('TestBoundary');
    }
  });

  it('throws BootError for invalid TypeScript syntax (unclosed brace)', () => {
    const badCode = `export default function(ctx) { return ctx.state.value`;
    expect(() => transpileScript('unclosed', 'MyBoundary', badCode))
      .toThrow(BootError);
  });

  it('returns CJS-compatible output (module.exports or exports)', () => {
    const code = `export default (ctx: { x: number }) => ctx.x + 1;`;
    const result = transpileScript('addOne', 'B', code);
    // esbuild CJS format uses Object.defineProperty(exports, ...) or exports.default
    expect(result).toMatch(/exports/);
  });
});
