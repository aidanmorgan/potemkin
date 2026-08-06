import {
  addSecurityHeaders,
  applyDebugEnvelope,
  applyPaginationControl,
  applyResponseFormat,
  compileMaskValuePatches,
  decorateStandaloneResponse,
  maskBody,
  maskValues,
  truncateSerializedBody,
} from '../../../src/core/responsePolicies.js';
import type {
  RuntimeBoundary,
  RuntimeExecutionResult,
  RuntimeRequest,
} from '../../../src/model/runtime.js';
import type { Command, DomainEvent } from '../../../src/contracts/domain.js';
import type { JsonObject } from '../../../src/contracts/value.js';
import {
  aggregateId,
  boundaryName,
  commandId,
  eventId,
  eventType,
  httpMethod,
  sequenceVersion,
} from '../../../src/domain/references.js';

const command: Command = {
  commandId: commandId('response-policy-command'),
  boundary: boundaryName('Widget'),
  intent: 'query',
  targetId: aggregateId('widget-1'),
  payload: {},
  queryParams: { tenant: ['acme', 'backup'], offset: '2', limit: '1', cursor: 'old' },
  httpMethod: httpMethod('GET'),
  path: '/widgets',
  origin: 'inbound',
  depth: 0,
};

const request: RuntimeRequest = { command, headers: {} };

const boundary = {
  boundary: 'Widget',
  contractPath: '/widgets',
  eventCatalog: [],
  behaviors: [],
  reducers: [],
} as RuntimeBoundary;

const event: DomainEvent = {
  eventId: eventId('event-1'),
  type: eventType('WidgetChanged'),
  boundary: boundaryName('Widget'),
  aggregateId: aggregateId('widget-1'),
  payload: { secret: 'event-secret', visible: true },
  timestamp: '2026-01-01T00:00:00.000Z',
  sequenceVersion: sequenceVersion(1),
  causedBy: null,
};

describe('response policy strategies', () => {
  it('masks recursive objects and arrays and compiles equivalent transport patches', () => {
    const body = {
      'private/key': 'root',
      nested: [{ 'private/key': 'child', keep: true }],
      metadata: { secret: 'top' },
    } as JsonObject;

    expect(maskBody(null, ['secret'])).toBeNull();
    expect(maskBody(body, [])).toBe(body);
    expect(maskValues(body, ['private/key', '/metadata/secret'])).toEqual({
      'private/key': '[MASKED]',
      nested: [{ 'private/key': '[MASKED]', keep: true }],
      metadata: { secret: '[MASKED]' },
    });
    expect(maskValues(body, ['/missing/path'])).toEqual(body);

    const patches = compileMaskValuePatches(body, ['private/key', '/metadata/secret', '/missing']);
    expect(patches.map((patch) => patch.path)).toEqual([
      '/private~1key',
      '/metadata/secret',
      '/nested/0/private~1key',
    ]);
    expect(compileMaskValuePatches(null, ['secret'])).toEqual([]);
    expect(compileMaskValuePatches(body, [])).toEqual([]);
    expect(compileMaskValuePatches({ secret: '[MASKED]' }, ['secret'])).toEqual([]);
  });

  it('truncates UTF-8 JSON safely and leaves invalid limits unchanged', () => {
    const body = { text: '😀' } as JsonObject;
    expect(truncateSerializedBody(null, 1)).toBeNull();
    expect(truncateSerializedBody(body, Number.NaN)).toBe(body);
    expect(truncateSerializedBody(body, -1)).toBe(body);
    expect(truncateSerializedBody(body, 10_000)).toBe(body);
    expect(truncateSerializedBody(body, 2)).toBe('{"');
    expect(typeof truncateSerializedBody(body, 10)).toBe('string');
  });

  it('supports raw, envelope, cursor-link, next-link, and previous-link pagination', () => {
    expect(applyPaginationControl({ status: 'ok' }, 'raw', request)).toEqual({
      body: { status: 'ok' },
      headers: {},
    });
    expect(applyPaginationControl([], 'raw', request)).toEqual({ body: [], headers: {} });

    const envelope = {
      items: [{ id: 'one' }],
      totalCount: 3,
      offset: 1,
      limit: 1,
      hasMore: true,
      nextCursor: 'next',
    } as JsonObject;
    expect(applyPaginationControl(envelope, 'envelope', request)).toEqual({
      body: envelope,
      headers: {},
    });
    const links = applyPaginationControl(envelope, 'link-header', request);
    expect(links.body).toEqual(envelope.items);
    expect(links.headers).toMatchObject({
      'X-Total-Count': '3',
      Link: expect.stringContaining('next'),
    });

    const offsetRequest = {
      ...request,
      command: { ...command, queryParams: { tenant: 'acme' } },
    } as RuntimeRequest;
    const previous = applyPaginationControl(
      { items: [{ id: 'one' }], totalCount: 2, offset: 1, limit: 1, hasMore: false },
      'link-header',
      offsetRequest,
    );
    expect(previous.headers.Link).toContain('rel="prev"');
    expect(applyPaginationControl({ items: [], totalCount: 0 }, 'envelope', request).body).toEqual({
      items: [],
      totalCount: 0,
      offset: 2,
      limit: 1,
      hasMore: false,
    });
  });

  it('uses the response format strategy for nulls, scalars, resources, collections, and pages', () => {
    expect(applyResponseFormat(null, 'plain', 'Widget', '/widgets')).toBeNull();
    expect(applyResponseFormat('value', 'hal', 'Widget', '/widgets')).toBe('value');
    expect(applyResponseFormat([{ id: '1' }], 'hal', 'Widget', '/widgets')).toMatchObject({
      _embedded: { items: [{ id: '1' }] },
      _links: { self: { href: '/widgets' } },
    });
    expect(
      applyResponseFormat(
        { items: [{ id: '1' }], totalCount: 1, offset: 0, limit: 1, hasMore: false },
        'hal',
        'Widget',
        '/widgets?x=1',
      ),
    ).toMatchObject({
      _embedded: { items: [{ id: '1' }] },
      _links: { self: { href: '/widgets' } },
    });
    expect(
      applyResponseFormat({ id: 1, _links: { existing: {} } }, 'hal', 'Widget', '/widgets/1'),
    ).toMatchObject({ id: 1, _links: { existing: {}, self: { href: '/widgets/1' } } });
    expect(
      applyResponseFormat({ id: '1', secret: true }, 'jsonapi', 'Widget', '/widgets/1'),
    ).toEqual({ data: { type: 'Widget', id: '1', attributes: { secret: true } } });
    expect(applyResponseFormat(['scalar'], 'jsonapi', 'Widget', '/widgets')).toEqual({
      data: [{ type: 'Widget', attributes: 'scalar' }],
    });
    expect(
      applyResponseFormat(
        { items: [{ id: 2 }], totalCount: 1, offset: 0, limit: 1, hasMore: false },
        'jsonapi',
        'Widget',
        '/widgets',
      ),
    ).toMatchObject({ data: [{ id: '2' }], meta: { totalCount: 1 } });
  });

  it('adds debug, security, trace, mask, and truncation decorations', () => {
    const withDebug = applyResponseFormat({ visible: true }, 'plain', 'Widget', '/widgets');
    expect(withDebug).toEqual({ visible: true });
    const debugRequest: RuntimeRequest = {
      ...request,
      controls: {
        includeEvents: true,
        echo: true,
        dryRun: true,
        traceId: 'trace-1',
        spanName: 'span-1',
        maskFields: ['secret'],
        bodyTruncateBytes: 10_000,
      },
    };
    const response: RuntimeExecutionResult = {
      status: 200,
      body: { secret: 'visible', value: 'ok' },
      headers: {},
      events: [],
      committed: false,
    };
    const decorated = decorateStandaloneResponse(response, debugRequest, { enabled: true });
    expect(decorated.headers).toMatchObject({
      'X-Potemkin-Dry-Run': 'true',
      'X-Potemkin-Trace-Id': 'trace-1',
      'X-Potemkin-Span-Name': 'span-1',
    });
    expect(decorated.body).toEqual({ secret: '[MASKED]', value: 'ok' });

    const debugBody = applyDebugEnvelope({ visible: true }, debugRequest, boundary, [event]);
    expect(debugBody).toMatchObject({
      _events: [{ payload: { secret: 'event-secret', visible: true } }],
      _debug: { boundary: 'Widget', dryRun: true },
    });

    const carrier = { headers: { Existing: 'yes' } };
    addSecurityHeaders(carrier, { enabled: false });
    expect(carrier.headers).toEqual({ Existing: 'yes' });
    addSecurityHeaders(carrier, {
      enabled: true,
      nosniff: true,
      frameDeny: true,
      hsts: true,
      includeSubDomains: false,
      referrerPolicy: 'no-referrer',
      customHeaders: { 'X-Custom': 'on' },
    });
    expect(carrier.headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=31536000',
      'Referrer-Policy': 'no-referrer',
      'X-Custom': 'on',
    });
  });
});
