/**
 * Coverage backfill for dsl/parser.ts
 *
 * Uncovered line 19:
 *  The branch coverage report shows line 19 at 75% (1 of 4 branches uncovered).
 *  Looking at parser.ts:
 *
 *  Line 18-19:
 *    } catch (err) {
 *      const message = err instanceof Error ? err.message : String(err);
 *
 *  The uncovered branch is `err instanceof Error ? ... : String(err)` —
 *  specifically the `String(err)` path when the thrown error is NOT an Error instance.
 *
 *  js-yaml normally throws YAMLException (an Error subclass). To trigger the non-Error
 *  branch, we need yaml.load to throw a non-Error value (string, number, etc.).
 *  We use jest.mock and jest.resetModules to achieve this.
 */

describe('dsl/parser.ts — line 19 non-Error throw coverage', () => {

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('handles non-Error throw from yaml.load — message uses String(err)', async () => {
    jest.resetModules();

    // Mock js-yaml to throw a plain string (non-Error)
    jest.mock('js-yaml', () => ({
      load: () => { throw 'non-error-string-42'; },
      dump: jest.fn(),
    }));

    const parserModule = await import('../../../src/dsl/parser');

    // The error thrown must be an instance of BootError from the same module
    // Since modules are reset, we import BootError from the same reset context
    const errorsModule = await import('../../../src/errors');
    const { BootError } = errorsModule;

    let caughtError: unknown;
    try {
      parserModule.parseDslYaml('valid: yaml');
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BootError);
    // The message should contain the string representation of the thrown value
    const msg = (caughtError as InstanceType<typeof BootError>).message;
    expect(msg).toContain('non-error-string-42');
  });

  it('handles numeric non-Error throw from yaml.load', async () => {
    jest.resetModules();

    jest.mock('js-yaml', () => ({
      load: () => { throw 42; }, // numeric throw
      dump: jest.fn(),
    }));

    const parserModule = await import('../../../src/dsl/parser');
    const { BootError } = await import('../../../src/errors');

    let caughtError: unknown;
    try {
      parserModule.parseDslYaml('some: yaml');
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BootError);
    const msg = (caughtError as InstanceType<typeof BootError>).message;
    // String(42) = '42' → should appear in the message
    expect(msg).toContain('42');
  });

  it('handles null throw from yaml.load', async () => {
    jest.resetModules();

    jest.mock('js-yaml', () => ({
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      load: () => { throw null; },
      dump: jest.fn(),
    }));

    const parserModule = await import('../../../src/dsl/parser');
    const { BootError } = await import('../../../src/errors');

    let caughtError: unknown;
    try {
      parserModule.parseDslYaml('some: yaml');
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BootError);
    // String(null) = 'null'
    const msg = (caughtError as InstanceType<typeof BootError>).message;
    expect(msg).toContain('null');
  });

  it('normal Error throw still uses err.message (existing path — control)', () => {
    // This verifies the positive branch (err instanceof Error) still works correctly.
    // js-yaml throws YAMLException which IS an Error subclass.
    const { parseDslYaml } = require('../../../src/dsl/parser');
    const { BootError } = require('../../../src/errors');

    let caughtError: unknown;
    try {
      parseDslYaml('{ bad yaml [[[');
      fail('should have thrown BootError for malformed YAML');
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BootError);
    expect((caughtError as InstanceType<typeof BootError>).code).toBe('BOOT_ERR_DSL_SYNTAX');
  });
});
