/**
 * Coverage backfill for observability/tracing.ts
 *
 * Uncovered lines:
 *  - 54: `instanceId = 'not-implemented'` catch branch when nextUuidv7 throws
 *  - 57: serviceName resolved from env var (OTEL_SERVICE_NAME) when opts.serviceName absent
 *  - 67-68: `{}` branch in traceExporterOpts/metricsExporterOpts when otlpEndpoint is undefined
 */

// resourceFromAttributes receives the resolved service attributes, so we
// intercept it to capture what tracing.ts passes. The real implementation is
// still called so SDK behaviour is unchanged.
const capturedResourceAttrs: { value: Record<string, unknown> | undefined } = {
  value: undefined,
};
jest.mock('@opentelemetry/resources', () => {
  const actual = jest.requireActual('@opentelemetry/resources');
  return {
    ...actual,
    resourceFromAttributes: (attrs: Record<string, unknown>) => {
      capturedResourceAttrs.value = attrs;
      return actual.resourceFromAttributes(attrs);
    },
  };
});

// ── Module-level: _serviceVersion ?? 'unknown' fallback (line 24) ────────────

describe('observability/tracing.ts — _serviceVersion fallback (line 24)', () => {
  it('_serviceVersion falls back to unknown when package.json has no version field', async () => {
    jest.resetModules();
    capturedResourceAttrs.value = undefined;

    // Mock the package.json so it has no 'version' field → _serviceVersion = 'unknown'
    jest.doMock('../../../package.json', () => ({ name: 'test-no-version' }), { virtual: false });

    const { initTracing } = await import('../../../src/observability/tracing');

    const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    // An explicit endpoint is required so the SDK init branch (Resource construction)
    // is reached rather than the early-return-on-no-endpoint branch.
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:19995';

    const result = await initTracing({ enabled: true, serviceName: 'version-fallback-test' });
    try {
      expect(capturedResourceAttrs.value).toBeDefined();
      // The fallback value flows through to the OTel Resource's service.version.
      expect(capturedResourceAttrs.value?.['service.version']).toBe('unknown');
    } finally {
      await result.shutdown().catch(() => undefined);
      if (prevEndpoint !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
      else delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      jest.resetModules();
      jest.dontMock('../../../package.json');
    }
  }, 15000);
});

describe('observability/tracing.ts — coverage backfill', () => {

  describe('initTracing — nextUuidv7 throws → instanceId falls back to randomUUID (line 54)', () => {
    it('uses a valid UUID instanceId when nextUuidv7 throws during SDK init', async () => {
      jest.resetModules();

      jest.mock('../../../src/ids/uuidv7', () => ({
        nextUuidv7: () => { throw new Error('not-implemented'); },
        epochAnchoredUuidv7: () => { throw new Error('not-implemented'); },
      }));

      const { initTracing } = await import('../../../src/observability/tracing');

      const prevDisabled = process.env['OTEL_SDK_DISABLED'];
      const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      capturedResourceAttrs.value = undefined;

      // Use a non-reachable endpoint to avoid real network I/O
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:19998';
      delete process.env['OTEL_SDK_DISABLED'];

      const result = await initTracing({ enabled: true, serviceName: 'test-tracing-fallback' });
      try {
        // When nextUuidv7 throws, instanceId falls back to crypto.randomUUID() —
        // a valid UUID, never the static 'not-implemented' placeholder.
        expect(typeof result.shutdown).toBe('function');
        const instanceId = capturedResourceAttrs.value?.['service.instance.id'] as string | undefined;
        expect(typeof instanceId).toBe('string');
        expect(instanceId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(instanceId).not.toBe('not-implemented');
      } finally {
        await result.shutdown().catch(() => undefined);
        if (prevDisabled !== undefined) process.env['OTEL_SDK_DISABLED'] = prevDisabled;
        else delete process.env['OTEL_SDK_DISABLED'];
        if (prevEndpoint !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
        else delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

        jest.resetModules();
        jest.unmock('../../../src/ids/uuidv7');
      }
    }, 15000);
  });

  // ── No otlpEndpoint → early return with no-op shutdown ──────────────────────

  describe('initTracing — no OTLP endpoint → returns no-op shutdown without starting exporters', () => {
    it('returns a no-op shutdown when no OTLP endpoint is configured', async () => {
      jest.resetModules();

      const { initTracing } = await import('../../../src/observability/tracing');

      const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      const prevDisabled = process.env['OTEL_SDK_DISABLED'];
      capturedResourceAttrs.value = undefined;

      // Ensure no endpoint is set — should trigger the early-return warning branch
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      delete process.env['OTEL_SDK_DISABLED'];

      const result = await initTracing({
        enabled: true,
        serviceName: 'test-no-endpoint',
        // otlpEndpoint deliberately omitted → undefined
      });
      try {
        // When no endpoint is configured, no OTel Resource is constructed
        // (no localhost exporter is created) and a no-op shutdown is returned.
        expect(typeof result.shutdown).toBe('function');
        await expect(result.shutdown()).resolves.toBeUndefined();
        // No Resource was constructed — capturedResourceAttrs remains undefined
        expect(capturedResourceAttrs.value).toBeUndefined();
      } finally {
        if (prevEndpoint !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
        else delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
        if (prevDisabled !== undefined) process.env['OTEL_SDK_DISABLED'] = prevDisabled;
        else delete process.env['OTEL_SDK_DISABLED'];

        jest.resetModules();
      }
    }, 15000);

    it('returns disabled shutdown when OTEL_SDK_DISABLED=true (enabled=false branch)', async () => {
      jest.resetModules();

      const { initTracing } = await import('../../../src/observability/tracing');

      const prev = process.env['OTEL_SDK_DISABLED'];
      process.env['OTEL_SDK_DISABLED'] = 'true';

      try {
        const result = await initTracing();
        // When disabled, shutdown is a no-op async fn
        expect(typeof result.shutdown).toBe('function');
        await result.shutdown(); // should not throw
      } finally {
        if (prev !== undefined) process.env['OTEL_SDK_DISABLED'] = prev;
        else delete process.env['OTEL_SDK_DISABLED'];
        jest.resetModules();
      }
    });
  });

  // ── Line 57: serviceName defaults to 'specmatic-stateful-sim' ──────────────

  describe('initTracing — serviceName falls back to specmatic-stateful-sim (line 57)', () => {
    it('uses default specmatic-stateful-sim when no serviceName and no OTEL_SERVICE_NAME', async () => {
      jest.resetModules();

      const { initTracing } = await import('../../../src/observability/tracing');

      const prevServiceName = process.env['OTEL_SERVICE_NAME'];
      const prevDisabled = process.env['OTEL_SDK_DISABLED'];
      const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      capturedResourceAttrs.value = undefined;

      // No serviceName and no OTEL_SERVICE_NAME → uses 'specmatic-stateful-sim' default.
      // An explicit endpoint is required so the SDK init branch (Resource construction)
      // is reached rather than the early-return-on-no-endpoint branch.
      delete process.env['OTEL_SERVICE_NAME'];
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:19997';
      delete process.env['OTEL_SDK_DISABLED'];

      // Call with enabled:true but no serviceName → hits ?? 'specmatic-stateful-sim' branch
      const result = await initTracing({ enabled: true });
      try {
        expect(typeof result.shutdown).toBe('function');
        expect(capturedResourceAttrs.value?.['service.name']).toBe('specmatic-stateful-sim');
      } finally {
        await result.shutdown().catch(() => undefined);
        if (prevServiceName !== undefined) process.env['OTEL_SERVICE_NAME'] = prevServiceName;
        else delete process.env['OTEL_SERVICE_NAME'];
        if (prevDisabled !== undefined) process.env['OTEL_SDK_DISABLED'] = prevDisabled;
        else delete process.env['OTEL_SDK_DISABLED'];
        if (prevEndpoint !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
        else delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
        jest.resetModules();
      }
    }, 15000);
  });

  // ── Line 57: serviceName from OTEL_SERVICE_NAME env var ─────────────────────

  describe('initTracing — serviceName from env var (line 57)', () => {
    it('uses OTEL_SERVICE_NAME env var when opts.serviceName is not provided', async () => {
      jest.resetModules();

      const { initTracing } = await import('../../../src/observability/tracing');

      const prevServiceName = process.env['OTEL_SERVICE_NAME'];
      const prevDisabled = process.env['OTEL_SDK_DISABLED'];
      const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      capturedResourceAttrs.value = undefined;

      process.env['OTEL_SERVICE_NAME'] = 'env-service-name-test';
      // An explicit endpoint is required so SDK init is reached rather than the
      // early-return-on-no-endpoint warning branch.
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:19996';
      delete process.env['OTEL_SDK_DISABLED'];

      // Pass enabled:true but NO serviceName — should use env var
      const result = await initTracing({ enabled: true });
      try {
        expect(typeof result.shutdown).toBe('function');
        expect(capturedResourceAttrs.value?.['service.name']).toBe('env-service-name-test');
      } finally {
        await result.shutdown().catch(() => undefined);
        if (prevServiceName !== undefined) process.env['OTEL_SERVICE_NAME'] = prevServiceName;
        else delete process.env['OTEL_SERVICE_NAME'];
        if (prevDisabled !== undefined) process.env['OTEL_SDK_DISABLED'] = prevDisabled;
        else delete process.env['OTEL_SDK_DISABLED'];
        if (prevEndpoint !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
        else delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
        jest.resetModules();
      }
    }, 15000);
  });
});

// ── potemkin-3vsq: fallback instanceId is a valid UUID, not 'not-implemented' ─

describe('potemkin-3vsq: instanceId fallback uses crypto.randomUUID()', () => {
  it('fallback instanceId is a valid UUID when nextUuidv7 throws', async () => {
    jest.resetModules();

    jest.mock('../../../src/ids/uuidv7', () => ({
      nextUuidv7: () => { throw new Error('uuid-unavailable'); },
      epochAnchoredUuidv7: () => { throw new Error('uuid-unavailable'); },
    }));

    const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    const prevDisabled = process.env['OTEL_SDK_DISABLED'];
    capturedResourceAttrs.value = undefined;
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:19994';
    delete process.env['OTEL_SDK_DISABLED'];

    const { initTracing } = await import('../../../src/observability/tracing');
    const result = await initTracing({ enabled: true, serviceName: 'uuid-fallback-test' });

    try {
      const instanceId = capturedResourceAttrs.value?.['service.instance.id'] as string | undefined;
      expect(typeof instanceId).toBe('string');
      // Must be a syntactically valid UUID
      expect(instanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // Must NOT be the old static placeholder
      expect(instanceId).not.toBe('not-implemented');
    } finally {
      await result.shutdown().catch(() => undefined);
      if (prevEndpoint !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
      else delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      if (prevDisabled !== undefined) process.env['OTEL_SDK_DISABLED'] = prevDisabled;
      else delete process.env['OTEL_SDK_DISABLED'];
      jest.resetModules();
      jest.unmock('../../../src/ids/uuidv7');
    }
  }, 15000);
});

// ── potemkin-kkrs: no endpoint → no localhost exporter, warning emitted ───────

describe('potemkin-kkrs: no OTLP endpoint configured → no localhost exporter started', () => {
  it('emits a warning and returns a no-op shutdown when no endpoint is configured', async () => {
    jest.resetModules();

    const warnCalls: unknown[][] = [];
    jest.mock('../../../src/observability/logger', () => {
      const actual = jest.requireActual('../../../src/observability/logger');
      return {
        ...actual,
        rootLogger: () => ({
          warn: (...args: unknown[]) => { warnCalls.push(args); },
          info: jest.fn(),
          error: jest.fn(),
          debug: jest.fn(),
        }),
      };
    });

    const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    const prevDisabled = process.env['OTEL_SDK_DISABLED'];
    capturedResourceAttrs.value = undefined;
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    delete process.env['OTEL_SDK_DISABLED'];

    const { initTracing } = await import('../../../src/observability/tracing');
    const result = await initTracing({ enabled: true, serviceName: 'no-endpoint-warn-test' });

    try {
      // A no-op shutdown is returned — not an OTLP-connected SDK
      expect(typeof result.shutdown).toBe('function');
      await expect(result.shutdown()).resolves.toBeUndefined();
      // No Resource was constructed (no localhost exporter was created)
      expect(capturedResourceAttrs.value).toBeUndefined();
      // A warning was emitted describing the missing endpoint
      expect(warnCalls.length).toBeGreaterThan(0);
      const warningMessage = warnCalls.flat().join(' ');
      expect(warningMessage).toMatch(/best-effort|disabled|no OTLP endpoint/i);
    } finally {
      if (prevEndpoint !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
      else delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      if (prevDisabled !== undefined) process.env['OTEL_SDK_DISABLED'] = prevDisabled;
      else delete process.env['OTEL_SDK_DISABLED'];
      jest.resetModules();
      jest.unmock('../../../src/observability/logger');
    }
  });
});
