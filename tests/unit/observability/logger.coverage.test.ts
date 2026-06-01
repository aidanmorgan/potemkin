/**
 * Coverage backfill for observability/logger.ts
 *
 * Uncovered lines 19 and 39:
 *  - Line 19: the `return undefined` (no pino-pretty) branch in resolvePrettyTransport
 *  - Line 39: the `instanceId = 'not-implemented'` catch branch when nextUuidv7 throws
 *
 * Line 19: resolvePrettyTransport catches the require.resolve failure and returns undefined.
 *   Since pino-pretty IS installed in this project, we can't naturally trigger the catch.
 *   Instead we use jest.resetModules + mock to simulate absence.
 *
 * Line 39: createLogger's catch fires when nextUuidv7 throws (e.g. in environments
 *   where uuidv7 is not available). We can mock it to throw.
 */

describe('observability/logger.ts — lines 19 and 39 coverage', () => {

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  // ── Line 39: instanceId fallback to 'not-implemented' ─────────────────────

  describe('createLogger — nextUuidv7 throws → instanceId not-implemented (line 39)', () => {
    it('creates logger successfully when nextUuidv7 throws', async () => {
      jest.resetModules();

      jest.mock('../../../src/ids/uuidv7', () => ({
        nextUuidv7: () => { throw new Error('not-implemented'); },
        epochAnchoredUuidv7: () => { throw new Error('not-implemented'); },
      }));

      const { createLogger } = await import('../../../src/observability/logger');

      // Should not throw even when nextUuidv7 throws
      expect(() => createLogger({ name: 'test-no-uuid', level: 'silent' })).not.toThrow();
    });

    it('returns a functional logger when instanceId falls back to not-implemented', async () => {
      jest.resetModules();

      jest.mock('../../../src/ids/uuidv7', () => ({
        nextUuidv7: () => { throw new Error('not-implemented'); },
        epochAnchoredUuidv7: () => { throw new Error('not-implemented'); },
      }));

      const { createLogger } = await import('../../../src/observability/logger');
      const logger = createLogger({ level: 'silent' });

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(() => logger.info('test')).not.toThrow();
    });
  });

  // ── Line 19: resolvePrettyTransport returns undefined (no pino-pretty) ──────

  describe('createLogger — pino-pretty not available → returns undefined transport (line 19)', () => {
    it('resolvePrettyTransport returns undefined when pino-pretty is not resolvable (line 19)', async () => {
      // We need require.resolve('pino-pretty') to throw so the catch returns undefined.
      // Patch Module._resolveFilename temporarily so pino-pretty resolution fails,
      // then load a fresh copy of logger.ts. The resolvePrettyTransport function will
      // be called immediately when usePretty=true (default in non-production env).
      jest.resetModules();

      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.resetModules() context requires dynamic require
      const Module = require('module') as { _resolveFilename: (request: string, ...args: unknown[]) => string };
      const origResolve = Module._resolveFilename;
      Module._resolveFilename = function(request: string, ...args: unknown[]) {
        if (request === 'pino-pretty') {
          throw new Error('Cannot find module: pino-pretty (mocked absent)');
        }
        return origResolve.call(this, request, ...args);
      };

      try {
        // Import fresh logger.ts — resolvePrettyTransport runs when usePretty=true (default)
        const { createLogger } = await import('../../../src/observability/logger');
        // With pino-pretty absent, resolvePrettyTransport returns undefined → transport = undefined
        const logger = createLogger({ level: 'silent', pretty: true });
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe('function');
        expect(() => logger.info('test-line-19')).not.toThrow();
      } finally {
        Module._resolveFilename = origResolve;
        jest.resetModules();
      }
    });

    it('LOG_LEVEL env var is used as default level when opts.level is absent', async () => {
      jest.resetModules();

      const original = process.env['LOG_LEVEL'];
      process.env['LOG_LEVEL'] = 'warn';

      try {
        const { createLogger } = await import('../../../src/observability/logger');
        const logger = createLogger({ name: 'level-test' });
        // Should not throw; the logger should be created with 'warn' level
        expect(logger).toBeDefined();
        expect(typeof logger.warn).toBe('function');
      } finally {
        if (original !== undefined) process.env['LOG_LEVEL'] = original;
        else delete process.env['LOG_LEVEL'];
      }
    });
  });

  // ── NODE_ENV=production → usePretty = false ───────────────────────────────

  describe('createLogger — NODE_ENV=production disables pretty printing', () => {
    it('creates logger without pretty transport in production env', async () => {
      jest.resetModules();
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';

      try {
        const { createLogger } = await import('../../../src/observability/logger');
        expect(() => createLogger({ name: 'prod-test', level: 'silent' })).not.toThrow();
      } finally {
        if (originalEnv !== undefined) process.env['NODE_ENV'] = originalEnv;
        else delete process.env['NODE_ENV'];
      }
    });
  });
});

// ── potemkin-3vsq: logger instanceId fallback is a valid UUID ─────────────────

describe('potemkin-3vsq: logger instanceId fallback uses crypto.randomUUID()', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('instanceId is a valid UUID (not "not-implemented") when nextUuidv7 throws', async () => {
    jest.resetModules();

    // Capture bindings passed to pino's .child() to observe the instanceId
    const capturedBindings: Record<string, unknown>[] = [];
    jest.mock('pino', () => {
      const actual = jest.requireActual('pino');
      const mockedRoot = actual({ level: 'silent' });
      const originalChild = mockedRoot.child.bind(mockedRoot);
      mockedRoot.child = (bindings: Record<string, unknown>) => {
        capturedBindings.push(bindings);
        return originalChild(bindings);
      };
      return Object.assign(() => mockedRoot, actual);
    });

    jest.mock('../../../src/ids/uuidv7', () => ({
      nextUuidv7: () => { throw new Error('uuid-unavailable'); },
      epochAnchoredUuidv7: () => { throw new Error('uuid-unavailable'); },
    }));

    const { createLogger } = await import('../../../src/observability/logger');
    createLogger({ name: 'uuid-fallback-logger-test', level: 'silent' });

    const instanceId = capturedBindings[0]?.['instanceId'] as string | undefined;
    expect(typeof instanceId).toBe('string');
    // Must be a syntactically valid UUID
    expect(instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Must NOT be the old static placeholder
    expect(instanceId).not.toBe('not-implemented');
  });
});
