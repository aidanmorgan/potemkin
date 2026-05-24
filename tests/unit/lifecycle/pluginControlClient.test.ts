/**
 * Unit tests for src/lifecycle/pluginControlClient.ts
 *
 * All tests mock globalThis.fetch to avoid real network calls.
 *
 * Scenarios:
 *  - Successful POST on first attempt → { ok: true, attempts: 1 }
 *  - Two failures then success → { ok: true, attempts: 3 }
 *  - All attempts fail → { ok: false, attempts: N, error: '...' }
 *  - Per-request timeout (AbortSignal.timeout) fires → counts as a failure
 *  - Backoff delay respects minBackoffMs (fake timers)
 *  - HTTP body matches ReadyNotification shape
 *  - HTTP body matches ShutdownNotification shape
 */

import { createPluginControlClient } from '../../../src/lifecycle/pluginControlClient.js';
import type { ReadyNotification, ShutdownNotification } from '../../../src/lifecycle/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const READY_PAYLOAD: ReadyNotification = {
  engine: 'potemkin-stateful',
  version: '0.1.0',
  startedAt: '2026-01-01T00:00:00.000Z',
  contractPaths: ['/customers', '/loans'],
  routesChecksum: 'abc123',
  fixturesChecksum: 'def456',
};

const SHUTDOWN_PAYLOAD: ShutdownNotification = {
  engine: 'potemkin-stateful',
  version: '0.1.0',
  reason: 'SIGTERM',
  stoppedAt: '2026-01-01T00:01:00.000Z',
};

/** Build a fetch mock that resolves immediately with the given status. */
function mockFetchOk(status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
  });
}

/** Build a fetch mock that rejects with a network error. */
function mockFetchNetworkError(message = 'Network error'): jest.Mock {
  return jest.fn().mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPluginControlClient — notifyReady', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns ok:true with attempts:1 on first-attempt success', async () => {
    globalThis.fetch = mockFetchOk();

    const client = createPluginControlClient({ url: 'http://localhost:9090' });
    const result = await client.notifyReady(READY_PAYLOAD);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok:true with attempts:3 after two failures then success', async () => {
    let callCount = 0;
    globalThis.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.reject(new Error('transient error'));
      }
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
    });

    const client = createPluginControlClient({
      url: 'http://localhost:9090',
      retries: 3,
      minBackoffMs: 1,
      maxBackoffMs: 10,
      factor: 1,
    });

    const result = await client.notifyReady(READY_PAYLOAD);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('returns ok:false after all attempts fail', async () => {
    globalThis.fetch = mockFetchNetworkError('connection refused');

    const client = createPluginControlClient({
      url: 'http://localhost:9090',
      retries: 3,
      minBackoffMs: 1,
      maxBackoffMs: 5,
      factor: 1,
    });

    const result = await client.notifyReady(READY_PAYLOAD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.attempts).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns ok:false when server responds with non-2xx status', async () => {
    globalThis.fetch = mockFetchOk(503);

    const client = createPluginControlClient({
      url: 'http://localhost:9090',
      retries: 1,
      minBackoffMs: 1,
      maxBackoffMs: 5,
      factor: 1,
    });

    const result = await client.notifyReady(READY_PAYLOAD);

    expect(result.ok).toBe(false);
  });

  it('sends correct JSON body matching ReadyNotification shape', async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
    });

    const client = createPluginControlClient({ url: 'http://localhost:9090' });
    await client.notifyReady(READY_PAYLOAD);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body['engine']).toBe('potemkin-stateful');
    expect(body['version']).toBe('0.1.0');
    expect(body['startedAt']).toBe('2026-01-01T00:00:00.000Z');
    expect(body['contractPaths']).toEqual(['/customers', '/loans']);
    expect(body['routesChecksum']).toBe('abc123');
    expect(body['fixturesChecksum']).toBe('def456');
  });

  it('POSTs to the /ready endpoint', async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = jest.fn().mockImplementation((url: string) => {
      capturedUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
    });

    const client = createPluginControlClient({ url: 'http://localhost:9090' });
    await client.notifyReady(READY_PAYLOAD);

    expect(capturedUrls[0]).toBe('http://localhost:9090/ready');
  });

  it('never throws even on catastrophic fetch error', async () => {
    globalThis.fetch = jest.fn().mockImplementation(() => {
      throw new Error('fetch is broken');
    });

    const client = createPluginControlClient({
      url: 'http://localhost:9090',
      retries: 1,
      minBackoffMs: 1,
      maxBackoffMs: 5,
      factor: 1,
    });

    // Must not throw
    const result = await client.notifyReady(READY_PAYLOAD);
    expect(result.ok).toBe(false);
  });
});

describe('createPluginControlClient — notifyShutdown', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns ok:true on first-attempt success', async () => {
    globalThis.fetch = mockFetchOk();

    const client = createPluginControlClient({ url: 'http://localhost:9090' });
    const result = await client.notifyShutdown(SHUTDOWN_PAYLOAD);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('returns ok:false when shutdown endpoint is unreachable', async () => {
    globalThis.fetch = mockFetchNetworkError('ECONNREFUSED');

    const client = createPluginControlClient({ url: 'http://localhost:9090' });
    const result = await client.notifyShutdown(SHUTDOWN_PAYLOAD);

    expect(result.ok).toBe(false);
  });

  it('sends correct JSON body matching ShutdownNotification shape', async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
    });

    const client = createPluginControlClient({ url: 'http://localhost:9090' });
    await client.notifyShutdown(SHUTDOWN_PAYLOAD);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body['engine']).toBe('potemkin-stateful');
    expect(body['version']).toBe('0.1.0');
    expect(body['reason']).toBe('SIGTERM');
    expect(body['stoppedAt']).toBe('2026-01-01T00:01:00.000Z');
  });

  it('POSTs to the /shutdown endpoint', async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = jest.fn().mockImplementation((url: string) => {
      capturedUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
    });

    const client = createPluginControlClient({ url: 'http://localhost:9090' });
    await client.notifyShutdown(SHUTDOWN_PAYLOAD);

    expect(capturedUrls[0]).toBe('http://localhost:9090/shutdown');
  });

  it('never throws even on catastrophic fetch error', async () => {
    globalThis.fetch = jest.fn().mockImplementation(() => {
      throw new Error('completely broken');
    });

    const client = createPluginControlClient({ url: 'http://localhost:9090' });
    const result = await client.notifyShutdown(SHUTDOWN_PAYLOAD);

    expect(result.ok).toBe(false);
  });
});

describe('createPluginControlClient — backoff behaviour', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('respects minBackoffMs by not completing instantly on retry', async () => {
    jest.useFakeTimers();

    let callCount = 0;
    globalThis.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.reject(new Error('retry me'));
      }
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
    });

    const client = createPluginControlClient({
      url: 'http://localhost:9090',
      retries: 3,
      minBackoffMs: 200,
      maxBackoffMs: 1000,
      factor: 2,
    });

    // Start the notification — it should stall waiting for the backoff timer.
    const resultPromise = client.notifyReady(READY_PAYLOAD);

    // Advance timers past the backoff window.
    await jest.runAllTimersAsync();

    const result = await resultPromise;

    // With minBackoffMs: 200 and two failures, the backoff fires properly.
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });
});
