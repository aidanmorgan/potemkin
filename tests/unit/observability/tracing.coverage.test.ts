/**
 * Coverage backfill for observability/tracing.ts
 *
 * Uncovered lines:
 *  - 54: `instanceId = 'not-implemented'` catch branch when nextUuidv7 throws
 *  - 57: serviceName resolved from env var (OTEL_SERVICE_NAME) when opts.serviceName absent
 *  - 67-68: `{}` branch in traceExporterOpts/metricsExporterOpts when otlpEndpoint is undefined
 */

// The Resource constructor receives the resolved service.version attribute, so
// we observe what tracing.ts puts there by subclassing the real Resource and
// recording the attributes it is constructed with. The subclass delegates to
// the real implementation, so SDK behaviour is unchanged.
const capturedResourceAttrs: { value: Record<string, unknown> | undefined } = {
  value: undefined,
};
jest.mock('@opentelemetry/resources', () => {
  const actual = jest.requireActual('@opentelemetry/resources');
  return {
    ...actual,
    Resource: class extends actual.Resource {
      constructor(attrs: Record<string, unknown>) {
        capturedResourceAttrs.value = attrs;
        super(attrs);
      }
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

    const result = await initTracing({ enabled: true, serviceName: 'version-fallback-test' });
    try {
      expect(capturedResourceAttrs.value).toBeDefined();
      // The fallback value flows through to the OTel Resource's service.version.
      expect(capturedResourceAttrs.value?.['service.version']).toBe('unknown');
    } finally {
      await result.shutdown().catch(() => undefined);
      jest.resetModules();
      jest.dontMock('../../../package.json');
    }
  }, 15000);
});

describe('observability/tracing.ts — coverage backfill', () => {

  describe('initTracing — nextUuidv7 throws → instanceId falls back to not-implemented (line 54)', () => {
    it('uses not-implemented instanceId when nextUuidv7 throws during SDK init', async () => {
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
        // When nextUuidv7 throws, instanceId falls back to 'not-implemented',
        // which is observable on the OTel Resource's service.instance.id attribute.
        expect(typeof result.shutdown).toBe('function');
        expect(capturedResourceAttrs.value?.['service.instance.id']).toBe('not-implemented');
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

  // ── Lines 67-68: no otlpEndpoint → empty exporter opts {} ───────────────────

  describe('initTracing — no OTLP endpoint → exporter opts are empty {} (lines 67-68)', () => {
    it('initialises SDK without otlpEndpoint — uses empty exporter opts', async () => {
      jest.resetModules();

      const { initTracing } = await import('../../../src/observability/tracing');

      const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      const prevDisabled = process.env['OTEL_SDK_DISABLED'];
      capturedResourceAttrs.value = undefined;

      // Ensure no endpoint is set — forces the `{}` branch at lines 67-68
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      delete process.env['OTEL_SDK_DISABLED'];

      const result = await initTracing({
        enabled: true,
        serviceName: 'test-no-endpoint',
        // otlpEndpoint deliberately omitted → undefined
      });
      try {
        // SDK construction succeeds even with no OTLP endpoint configured,
        // taking the empty-exporter-opts branch; the full init path ran, which
        // we confirm via the resolved service.name on the Resource.
        expect(typeof result.shutdown).toBe('function');
        expect(capturedResourceAttrs.value?.['service.name']).toBe('test-no-endpoint');
      } finally {
        await result.shutdown().catch(() => undefined);
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

      // No serviceName and no OTEL_SERVICE_NAME → uses 'specmatic-stateful-sim' default
      delete process.env['OTEL_SERVICE_NAME'];
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
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
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
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
