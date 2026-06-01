import { Writable } from 'node:stream';
import { createLogger, rootLogger, childLogger, _resetRootPinoForTest } from '../../../src/observability/logger';
import type pino from 'pino';

// Use 'fatal' as a practical way to suppress most output in tests
const QUIET: pino.Level = 'fatal';

function makeCapture(): { dest: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { dest, lines: () => chunks };
}

describe('observability/logger', () => {
  afterEach(() => {
    // Reset singleton so capture tests don't bleed into later tests
    _resetRootPinoForTest();
  });

  describe('createLogger', () => {
    it('returns a logger instance with required methods', () => {
      const logger = createLogger({ name: 'test', level: QUIET });
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('creates logger with custom name', () => {
      const logger = createLogger({ name: 'my-service', level: QUIET });
      expect(logger).toBeDefined();
    });

    it('creates logger without options', () => {
      expect(() => createLogger()).not.toThrow();
    });

    it('creates logger with pretty: false in test env', () => {
      expect(() => createLogger({ pretty: false, level: QUIET })).not.toThrow();
    });

    it('creates logger with pretty: true', () => {
      // pino-pretty may or may not be available; should not throw
      expect(() => createLogger({ pretty: true, level: QUIET })).not.toThrow();
    });

    it('logger.info emits an info-level record with the message and fields', (done) => {
      _resetRootPinoForTest();
      const { dest, lines } = makeCapture();
      const logger = createLogger({ level: 'info', _dest: dest });
      logger.info({ requestId: 'r-1' }, 'hello info');
      setImmediate(() => {
        const parsed = JSON.parse(lines().join('')) as Record<string, unknown>;
        expect(parsed['level']).toBe(30);
        expect(parsed['msg']).toBe('hello info');
        expect(parsed['requestId']).toBe('r-1');
        done();
      });
    });

    it('logger.error emits an error-level record with the message and fields', (done) => {
      _resetRootPinoForTest();
      const { dest, lines } = makeCapture();
      const logger = createLogger({ level: 'info', _dest: dest });
      logger.error({ err: new Error('boom') }, 'error message');
      setImmediate(() => {
        const parsed = JSON.parse(lines().join('')) as Record<string, unknown>;
        expect(parsed['level']).toBe(50);
        expect(parsed['msg']).toBe('error message');
        done();
      });
    });

    it('accepts bindings in options', () => {
      expect(() =>
        createLogger({ bindings: { service: 'test-service' }, level: QUIET }),
      ).not.toThrow();
    });
  });

  describe('rootLogger', () => {
    it('returns a logger instance', () => {
      const logger = rootLogger();
      expect(typeof logger.info).toBe('function');
    });

    it('returns the same instance on subsequent calls (singleton)', () => {
      const l1 = rootLogger();
      const l2 = rootLogger();
      expect(l1).toBe(l2);
    });
  });

  describe('childLogger', () => {
    it('creates a child logger with additional bindings', () => {
      const parent = createLogger({ level: QUIET });
      const child = childLogger(parent, { requestId: 'req-1' });
      expect(typeof child.info).toBe('function');
    });

    it('child logger emits an info-level record with parent and child bindings merged', (done) => {
      _resetRootPinoForTest();
      const { dest, lines } = makeCapture();
      const parent = createLogger({ name: 'parent-svc', level: 'info', _dest: dest });
      const child = childLogger(parent, { context: 'test', requestId: 'req-child' });
      child.info('child message');
      setImmediate(() => {
        const parsed = JSON.parse(lines().join('')) as Record<string, unknown>;
        expect(parsed['level']).toBe(30);
        expect(parsed['msg']).toBe('child message');
        expect(parsed['context']).toBe('test');
        expect(parsed['requestId']).toBe('req-child');
        done();
      });
    });

    it('child is distinct from parent', () => {
      const parent = createLogger({ level: QUIET });
      const child = childLogger(parent, {});
      expect(child).not.toBe(parent);
    });
  });
});
