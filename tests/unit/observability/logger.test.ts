import { createLogger, rootLogger, childLogger } from '../../../src/observability/logger';
import type pino from 'pino';

// Use 'fatal' as a practical way to suppress most output in tests
const QUIET: pino.Level = 'fatal';

describe('observability/logger', () => {
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

    it('logger.info returns undefined (call completes synchronously)', () => {
      const logger = createLogger({ level: QUIET });
      const result = logger.info('test message');
      expect(result).toBeUndefined();
    });

    it('logger.error returns undefined (call completes synchronously)', () => {
      const logger = createLogger({ level: QUIET });
      const result = logger.error({ err: new Error('test') }, 'error message');
      expect(result).toBeUndefined();
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

    it('child logger.info returns undefined (call completes synchronously)', () => {
      const parent = createLogger({ level: QUIET });
      const child = childLogger(parent, { context: 'test' });
      const result = child.info('child message');
      expect(result).toBeUndefined();
    });

    it('child is distinct from parent', () => {
      const parent = createLogger({ level: QUIET });
      const child = childLogger(parent, {});
      expect(child).not.toBe(parent);
    });
  });
});
