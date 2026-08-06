import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Attributes, Span, Tracer } from '@opentelemetry/api';
import type { RuntimeTransportObservation } from '../../../src/contracts/ports.js';
import { commandId } from '../../../src/domain/references.js';
import { createRuntimeOtelRequestResponseObserver } from '../../../src/observability/runtimeExchange.js';

interface ExportedSpan {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/**
 * The exporter is deliberately synchronous. That makes each assertion about
 * a completed exchange deterministic without depending on an SDK timer or a
 * network exporter.
 */
class MockSpanExporter {
  readonly spans: ExportedSpan[] = [];

  export(span: ExportedSpan): void {
    this.spans.push(span);
  }
}

function createMockTracer(exporter: MockSpanExporter): Tracer {
  return {
    startActiveSpan(name: string, callback: (span: Span) => unknown): unknown {
      const attributes: Record<string, unknown> = {};
      let ended = false;
      const span = {
        setAttributes(values: Attributes): Span {
          Object.assign(attributes, values);
          return this as unknown as Span;
        },
        setAttribute(key: string, value: unknown): Span {
          attributes[key] = value;
          return this as unknown as Span;
        },
        end(): void {
          if (ended) return;
          ended = true;
          exporter.export({ name, attributes: { ...attributes } });
        },
      };

      return callback(span as unknown as Span);
    },
  } as unknown as Tracer;
}

function observeWithNoActiveSpan(
  observer: (observation: RuntimeTransportObservation) => void,
  observation: RuntimeTransportObservation,
): void {
  context.with(ROOT_CONTEXT, () => observer(observation));
}

describe('createRuntimeOtelRequestResponseObserver', () => {
  it('exports the original request and final successful response with bounded redacted bodies', () => {
    const exporter = new MockSpanExporter();
    const observer = createRuntimeOtelRequestResponseObserver({
      tracer: createMockTracer(exporter),
      spanName: 'potemkin.test.exchange',
    });
    const observation: RuntimeTransportObservation = {
      request: {
        method: 'POST',
        path: '/orders',
        query: { tenant: 'acme', tag: ['priority', 'new'] },
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer [REDACTED]',
        },
        body: {
          captured: true,
          value: { customer: 'alice', cardNumber: '[REDACTED]' },
          bytes: 52,
          truncated: false,
        },
      },
      response: {
        status: 201,
        headers: {
          'content-type': 'application/json',
          etag: '"order-1"',
        },
        body: {
          captured: true,
          // This is the bounded, already-serialized value supplied by the
          // transport observation after response shaping and redaction.
          value: '{"id":"order-1","cardNumber":"[REDACTED]"',
          bytes: 58,
          truncated: true,
        },
      },
      correlation: {
        traceId: 'trace-success-01',
        commandId: commandId('command-order-01'),
      },
    };

    observeWithNoActiveSpan(observer, observation);

    expect(exporter.spans).toHaveLength(1);
    const span = exporter.spans[0]!;
    expect(span.name).toBe('potemkin.test.exchange');
    expect(span.attributes).toEqual(
      expect.objectContaining({
        'potemkin.request.method': 'POST',
        'potemkin.request.path': '/orders',
        'potemkin.request.query': JSON.stringify(observation.request.query),
        'potemkin.request.headers': JSON.stringify(observation.request.headers),
        'potemkin.request.body.captured': true,
        'potemkin.request.body.bytes': 52,
        'potemkin.request.body.truncated': false,
        'potemkin.request.body': JSON.stringify(observation.request.body.value),
        'potemkin.response.status': 201,
        'potemkin.response.headers': JSON.stringify(observation.response.headers),
        'potemkin.response.body.captured': true,
        'potemkin.response.body.bytes': 58,
        'potemkin.response.body.truncated': true,
        'potemkin.response.body': JSON.stringify(observation.response.body.value),
        'potemkin.trace_id': 'trace-success-01',
        'potemkin.command_id': 'command-order-01',
      }),
    );
    expect(JSON.stringify(span.attributes)).not.toContain('4111 1111 1111 1111');
  });

  it('exports the final validation failure rather than an intermediate engine result', () => {
    const exporter = new MockSpanExporter();
    const observer = createRuntimeOtelRequestResponseObserver({
      tracer: createMockTracer(exporter),
    });
    const observation: RuntimeTransportObservation = {
      request: {
        method: 'PATCH',
        path: '/orders/order-2',
        query: {},
        headers: { 'x-request-id': 'request-failure-02' },
        body: {
          captured: true,
          value: { status: 'invalid', secret: '[REDACTED]' },
          bytes: 44,
          truncated: false,
        },
      },
      response: {
        status: 422,
        headers: {
          'content-type': 'application/problem+json',
          'x-potemkin-error': 'validation',
        },
        body: {
          captured: true,
          value: {
            code: 'VALIDATION_ERROR',
            message: 'status must be one of pending, accepted, or rejected',
          },
          bytes: 92,
          truncated: false,
        },
      },
      correlation: {
        traceId: 'trace-failure-02',
        commandId: commandId('command-order-02'),
      },
    };

    observeWithNoActiveSpan(observer, observation);

    expect(exporter.spans).toHaveLength(1);
    const attributes = exporter.spans[0]!.attributes;
    expect(attributes['potemkin.response.status']).toBe(422);
    expect(attributes['potemkin.response.headers']).toBe(
      JSON.stringify(observation.response.headers),
    );
    expect(attributes['potemkin.response.body']).toBe(
      JSON.stringify(observation.response.body.value),
    );
    expect(attributes['potemkin.response.body.bytes']).toBe(92);
    expect(attributes['potemkin.response.body.truncated']).toBe(false);
    expect(attributes['potemkin.trace_id']).toBe('trace-failure-02');
    expect(attributes['potemkin.command_id']).toBe('command-order-02');
  });

  it('exports a closed transport with an explicit omitted-body state and correlation', () => {
    const exporter = new MockSpanExporter();
    const observer = createRuntimeOtelRequestResponseObserver({
      tracer: createMockTracer(exporter),
    });
    const observation: RuntimeTransportObservation = {
      request: {
        method: 'POST',
        path: '/orders',
        query: {},
        headers: { 'x-potemkin-drop-connection': '25' },
        body: { captured: false, bytes: 0, truncated: false },
      },
      response: {
        // A direct connection drop has no HTTP response body. The transport
        // The transport implementation still supplies the terminal status it observed.
        status: 200,
        headers: {},
        body: { captured: false, bytes: 0, truncated: false },
        connectionClosed: true,
      },
      correlation: {
        traceId: 'trace-closed-03',
        commandId: commandId('command-order-03'),
      },
    };

    observeWithNoActiveSpan(observer, observation);

    expect(exporter.spans).toHaveLength(1);
    const attributes = exporter.spans[0]!.attributes;
    expect(attributes).toEqual(
      expect.objectContaining({
        'potemkin.request.body.captured': false,
        'potemkin.response.body.captured': false,
        'potemkin.response.body.bytes': 0,
        'potemkin.response.body.truncated': false,
        'potemkin.response.connection_closed': true,
        'potemkin.trace_id': 'trace-closed-03',
        'potemkin.command_id': 'command-order-03',
      }),
    );
    expect(attributes).not.toHaveProperty('potemkin.request.body');
    expect(attributes).not.toHaveProperty('potemkin.response.body');
  });
});
