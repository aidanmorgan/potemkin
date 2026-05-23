/**
 * Barrel-file coverage tests.
 *
 * Each import exercises the barrel's re-exports, lifting the "0% functions"
 * Istanbul measurement that appears when a barrel module is never imported.
 */

describe('barrel files re-export expected names', () => {
  describe('src/schema/index.ts', () => {
    it('exports deriveSchemasFromOpenApi', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.deriveSchemasFromOpenApi).toBe('function');
    });

    it('exports typeOfJson', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.typeOfJson).toBe('function');
    });

    it('exports isAssignable', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.isAssignable).toBe('function');
    });

    it('exports validateEntityAgainstSchema', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.validateEntityAgainstSchema).toBe('function');
    });

    it('exports resolvePath', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.resolvePath).toBe('function');
    });

    it('exports isValidPath', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.isValidPath).toBe('function');
    });

    it('exports pathExists', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.pathExists).toBe('function');
    });

    it('exports staticCheckDsl', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.staticCheckDsl).toBe('function');
    });

    it('exports guardAssignPath', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.guardAssignPath).toBe('function');
    });

    it('exports guardAssignedValue', async () => {
      const mod = await import('../../src/schema/index');
      expect(typeof mod.guardAssignedValue).toBe('function');
    });
  });

  describe('src/observability/index.ts', () => {
    it('exports createLogger', async () => {
      const mod = await import('../../src/observability/index');
      expect(typeof mod.createLogger).toBe('function');
    });

    it('exports rootLogger', async () => {
      const mod = await import('../../src/observability/index');
      expect(typeof mod.rootLogger).toBe('function');
    });

    it('exports childLogger', async () => {
      const mod = await import('../../src/observability/index');
      expect(typeof mod.childLogger).toBe('function');
    });

    it('exports initTracing', async () => {
      const mod = await import('../../src/observability/index');
      expect(typeof mod.initTracing).toBe('function');
    });

    it('exports getTracer', async () => {
      const mod = await import('../../src/observability/index');
      expect(typeof mod.getTracer).toBe('function');
    });

    it('exports withSpan', async () => {
      const mod = await import('../../src/observability/index');
      expect(typeof mod.withSpan).toBe('function');
    });

    it('exports recordException', async () => {
      const mod = await import('../../src/observability/index');
      expect(typeof mod.recordException).toBe('function');
    });

    it('exports createEngineMetrics', async () => {
      const mod = await import('../../src/observability/index');
      expect(typeof mod.createEngineMetrics).toBe('function');
    });

    it('exports SpanStatusCode', async () => {
      const mod = await import('../../src/observability/index');
      expect(mod.SpanStatusCode).toBeDefined();
    });
  });
});
