/**
 * Unit tests for observability/tracing.ts
 *
 * Goals: cover initTracing (disabled path), getTracer, withSpan (success + error paths),
 * recordException (Error and non-Error paths), and the initTracing enabled path.
 *
 * The OTel SDK actually starts exporters when enabled=true, so we keep the
 * enabled=true test light — just assert it returns a shutdown function without
 * throwing.  We shut the SDK down immediately to avoid open handles.
 */

import {
  initTracing,
  getTracer,
  withSpan,
  recordException,
  SpanStatusCode,
} from '../../../src/observability/tracing';
import type { Span, Tracer } from '../../../src/observability/tracing';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeSpan(): Span & {
  _status: { code: number } | null;
  _exceptions: unknown[];
  _ended: boolean;
} {
  const span = {
    _status: null as { code: number } | null,
    _exceptions: [] as unknown[],
    _ended: false,
    setAttribute: jest.fn(),
    setStatus(s: { code: number }) {
      this._status = s;
    },
    recordException(e: unknown) {
      this._exceptions.push(e);
    },
    end() {
      this._ended = true;
    },
  };
  return span as unknown as Span & {
    _status: { code: number } | null;
    _exceptions: unknown[];
    _ended: boolean;
  };
}

/**
 * Build a minimal Tracer stub that drives startActiveSpan synchronously
 * so tests don't need real OTel infrastructure.
 */
function makeTracer(): Tracer & { lastSpan: ReturnType<typeof makeSpan> | null } {
  const state = { lastSpan: null as ReturnType<typeof makeSpan> | null };
  const tracer = {
    get lastSpan() {
      return state.lastSpan;
    },
    startActiveSpan<T>(_name: string, fn: (span: Span) => T): T {
      const span = makeSpan();
      state.lastSpan = span;
      return fn(span as unknown as Span);
    },
  };
  return tracer as unknown as Tracer & { lastSpan: ReturnType<typeof makeSpan> | null };
}

// ── initTracing ────────────────────────────────────────────────────────────────

describe('observability/tracing', () => {
  describe('initTracing', () => {
    it('returns a no-op shutdown when enabled: false', async () => {
      const { shutdown } = await initTracing({ enabled: false });
      // Must not throw and must be callable
      await expect(shutdown()).resolves.toBeUndefined();
    });

    it('respects OTEL_SDK_DISABLED=true env var when opts.enabled is not specified', async () => {
      const original = process.env['OTEL_SDK_DISABLED'];
      process.env['OTEL_SDK_DISABLED'] = 'true';
      try {
        const { shutdown } = await initTracing();
        await expect(shutdown()).resolves.toBeUndefined();
      } finally {
        if (original === undefined) {
          delete process.env['OTEL_SDK_DISABLED'];
        } else {
          process.env['OTEL_SDK_DISABLED'] = original;
        }
      }
    });

    it('enabled=true path: initTracing returns a callable shutdown function', async () => {
      // The enabled=true branch reaches the SDK-construction block and returns a
      // shutdown fn. The OTLP exporters buffer rather than connect at init, so
      // SDK construction does not require network reachability; we point at a
      // local no-op endpoint so no real traffic goes out, then shut down
      // immediately to avoid background-timer leaks.
      const prevDisabled = process.env['OTEL_SDK_DISABLED'];
      const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:19999';
      delete process.env['OTEL_SDK_DISABLED'];

      try {
        const result = await initTracing({ enabled: true, serviceName: 'test-coverage-svc' });
        // Distinct from the disabled path: a real (callable) shutdown is returned
        // that resolves without throwing.
        expect(typeof result.shutdown).toBe('function');
        await expect(result.shutdown()).resolves.toBeUndefined();
      } finally {
        if (prevDisabled !== undefined) process.env['OTEL_SDK_DISABLED'] = prevDisabled;
        else delete process.env['OTEL_SDK_DISABLED'];
        if (prevEndpoint !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
        else delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      }
    }, 15000);
  });

  // ── getTracer ──────────────────────────────────────────────────────────────

  describe('getTracer', () => {
    it('returns a tracer with a default name', () => {
      const tracer = getTracer();
      expect(tracer).toBeDefined();
      expect(typeof (tracer as object)).toBe('object');
    });

    it('returns a tracer when given an explicit name', () => {
      const tracer = getTracer('my-service');
      expect(tracer).toBeDefined();
    });
  });

  // ── withSpan ───────────────────────────────────────────────────────────────

  describe('withSpan', () => {
    it('returns the value produced by the callback', async () => {
      const tracer = makeTracer();
      const result = await withSpan(tracer as unknown as Tracer, 'test-span', async () => 42);
      expect(result).toBe(42);
    });

    it('ends the span after a successful callback', async () => {
      const tracer = makeTracer();
      await withSpan(tracer as unknown as Tracer, 'test-span', async (span) => {
        void span;
      });
      expect(tracer.lastSpan?._ended).toBe(true);
    });

    it('sets span attributes when attrs provided', async () => {
      const tracer = makeTracer();
      await withSpan(
        tracer as unknown as Tracer,
        'test-span',
        async (_span) => 'ok',
        { 'my.attr': 'value', 'count': 1 },
      );
      expect(tracer.lastSpan?.setAttribute).toHaveBeenCalledWith('my.attr', 'value');
      expect(tracer.lastSpan?.setAttribute).toHaveBeenCalledWith('count', 1);
    });

    it('records exception and sets ERROR status on throw, then re-throws', async () => {
      const tracer = makeTracer();
      const err = new Error('boom');
      await expect(
        withSpan(tracer as unknown as Tracer, 'test-span', async () => {
          throw err;
        }),
      ).rejects.toThrow('boom');

      expect(tracer.lastSpan?._exceptions).toContain(err);
      expect(tracer.lastSpan?._status?.code).toBe(SpanStatusCode.ERROR);
      expect(tracer.lastSpan?._ended).toBe(true);
    });

    it('ends the span even when callback throws', async () => {
      const tracer = makeTracer();
      await withSpan(tracer as unknown as Tracer, 'boom', async () => {
        throw new Error('fail');
      }).catch(() => undefined);
      expect(tracer.lastSpan?._ended).toBe(true);
    });

    it('works with a synchronous callback that returns immediately', async () => {
      const tracer = makeTracer();
      const result = await withSpan(tracer as unknown as Tracer, 'sync', (span) => {
        void span;
        return 'sync-value';
      });
      expect(result).toBe('sync-value');
    });
  });

  // ── recordException ────────────────────────────────────────────────────────

  describe('recordException', () => {
    it('calls span.recordException with the Error instance', () => {
      const span = makeSpan();
      const err = new Error('record me');
      recordException(span as unknown as Span, err);
      expect(span._exceptions).toContain(err);
    });

    it('calls span.recordException with String(err) for non-Error values', () => {
      const span = makeSpan();
      recordException(span as unknown as Span, 'just a string error');
      expect(span._exceptions).toContain('just a string error');
    });

    it('sets ERROR status on the span', () => {
      const span = makeSpan();
      recordException(span as unknown as Span, new Error('x'));
      expect(span._status?.code).toBe(SpanStatusCode.ERROR);
    });

    it('handles numeric non-Error values', () => {
      const span = makeSpan();
      recordException(span as unknown as Span, 404);
      expect(span._exceptions).toContain('404');
    });
  });
});
