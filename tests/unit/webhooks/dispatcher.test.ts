/**
 * Unit tests for the webhook dispatcher — trigger matching, CEL payload
 * templating, HMAC-SHA256 signing and injectable-transport delivery.
 */

import { createHmac } from 'node:crypto';
import {
  webhookMatches,
  resolveWebhookUrl,
  buildWebhookPayload,
  signWebhookBody,
  prepareWebhookDelivery,
  deliverWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  type FetchLike,
} from '../../../src/webhooks/dispatcher';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import type { WebhookConfig } from '../../../src/dsl/types';
import type { DomainEvent } from '../../../src/types';

/** async-retry overrides for deterministic, zero-delay tests. */
const noDelay = { minTimeout: 0, maxTimeout: 0, randomize: false };

const cel = createCelEvaluator();

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'evt-1',
    type: 'LeadConverted',
    boundary: 'LeadConvert',
    aggregateId: 'lead-123',
    payload: { agentId: 'agent-9' },
    timestamp: '2024-01-01T00:00:00.000Z',
    sequenceVersion: 1,
    causedBy: 'cmd-1',
    ...overrides,
  };
}

const WEBHOOK: WebhookConfig = {
  name: 'lead-converted',
  trigger: { boundary: 'LeadConvert', intent: 'mutation', condition: "event.type == 'LeadConverted'" },
  url: "'http://example.test/webhook'",
  secret: 'webhook-secret',
  payload: { leadId: '${event.aggregateId}', kind: '${event.type}' },
};

describe('webhooks/dispatcher — matching & templating', () => {
  it('matches when boundary, intent and condition all hold', () => {
    expect(webhookMatches(WEBHOOK, makeEvent(), 'LeadConvert', 'mutation', cel)).toBe(true);
  });

  it('does not match when the boundary differs', () => {
    expect(webhookMatches(WEBHOOK, makeEvent(), 'Other', 'mutation', cel)).toBe(false);
  });

  it('does not match when the CEL condition is false', () => {
    expect(webhookMatches(WEBHOOK, makeEvent({ type: 'LeadCreated' }), 'LeadConvert', 'mutation', cel)).toBe(false);
  });

  it('resolves a CEL string-literal url', () => {
    expect(resolveWebhookUrl(WEBHOOK, makeEvent(), cel)).toBe('http://example.test/webhook');
  });

  it('builds the payload from the ${} templates', () => {
    expect(buildWebhookPayload(WEBHOOK, makeEvent(), cel)).toEqual({ leadId: 'lead-123', kind: 'LeadConverted' });
  });
});

describe('webhooks/dispatcher — signing', () => {
  it('signs the body with HMAC-SHA256 reproducibly', () => {
    const body = JSON.stringify({ a: 1 });
    const expected = createHmac('sha256', 'webhook-secret').update(body).digest('hex');
    expect(signWebhookBody(body, 'webhook-secret')).toBe(expected);
  });

  it('prepareWebhookDelivery produces a signed delivery whose signature verifies', () => {
    const delivery = prepareWebhookDelivery(WEBHOOK, makeEvent(), 'LeadConvert', 'mutation', cel);
    expect(delivery).not.toBeNull();
    const sig = delivery!.headers[WEBHOOK_SIGNATURE_HEADER];
    const recomputed = 'sha256=' + createHmac('sha256', 'webhook-secret').update(delivery!.body).digest('hex');
    expect(sig).toBe(recomputed);
    expect(delivery!.url).toBe('http://example.test/webhook');
  });

  it('returns null when the webhook does not match', () => {
    expect(prepareWebhookDelivery(WEBHOOK, makeEvent({ type: 'Nope' }), 'LeadConvert', 'mutation', cel)).toBeNull();
  });
});

describe('webhooks/dispatcher — delivery', () => {
  it('delivers via the injected transport and reports success', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200 };
    };
    const delivery = prepareWebhookDelivery(WEBHOOK, makeEvent(), 'LeadConvert', 'mutation', cel)!;
    const result = await deliverWebhook(delivery, fetchImpl, undefined, noDelay);
    expect(result).toMatchObject({ attempts: 1, delivered: true, lastStatus: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://example.test/webhook');
  });

  it('retries up to explicit maxAttempts override on transport failure and reports failure', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return { ok: false, status: 503 };
    };
    const delivery = prepareWebhookDelivery(WEBHOOK, makeEvent(), 'LeadConvert', 'mutation', cel)!;
    const result = await deliverWebhook(delivery, fetchImpl, { maxAttempts: 3 }, noDelay);
    expect(attempts).toBe(3);
    expect(result).toMatchObject({ attempts: 3, delivered: false, lastStatus: 503 });
  });

  it('never throws when the transport throws', async () => {
    const fetchImpl: FetchLike = async () => { throw new Error('network down'); };
    const delivery = prepareWebhookDelivery(WEBHOOK, makeEvent(), 'LeadConvert', 'mutation', cel)!;
    const result = await deliverWebhook(delivery, fetchImpl, { maxAttempts: 2 }, noDelay);
    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(2);
  });

  it('retries by default (no retry config) and delivers on the second attempt after a 503', async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = async () => {
      callCount += 1;
      return callCount === 1
        ? { ok: false, status: 503 }
        : { ok: true, status: 200 };
    };
    const delivery = prepareWebhookDelivery(WEBHOOK, makeEvent(), 'LeadConvert', 'mutation', cel)!;
    const result = await deliverWebhook(delivery, fetchImpl, undefined, noDelay);
    expect(result.delivered).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.lastStatus).toBe(200);
  });

  it('honors an explicit maxAttempts override via retryConfig', async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = async () => {
      callCount += 1;
      return { ok: false, status: 503 };
    };
    const delivery = prepareWebhookDelivery(WEBHOOK, makeEvent(), 'LeadConvert', 'mutation', cel)!;
    const result = await deliverWebhook(
      delivery,
      fetchImpl,
      { maxAttempts: 2, delayMs: 500 },
      noDelay,
    );
    expect(result.attempts).toBe(2);
    expect(result.delivered).toBe(false);
    expect(result.lastStatus).toBe(503);
    expect(callCount).toBe(2);
  });
});

describe('webhooks/dispatcher — permanent 4xx bail (no retry)', () => {
  const delivery = {
    url: 'http://example.test/webhook',
    headers: {},
    body: '{}',
  };

  it.each([400, 401, 403, 404, 410])(
    'status %i is attempted exactly once — no retry',
    async (status) => {
      let callCount = 0;
      const fetchImpl: FetchLike = async () => {
        callCount += 1;
        return { ok: false, status };
      };
      const result = await deliverWebhook(delivery, fetchImpl, { maxAttempts: 3 }, noDelay);
      expect(callCount).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.delivered).toBe(false);
      expect(result.lastStatus).toBe(status);
    },
  );

  it('503 (server error) still retries to maxAttempts', async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = async () => {
      callCount += 1;
      return { ok: false, status: 503 };
    };
    const result = await deliverWebhook(delivery, fetchImpl, { maxAttempts: 3 }, noDelay);
    expect(callCount).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.delivered).toBe(false);
    expect(result.lastStatus).toBe(503);
  });

  it('429 (too many requests) is retriable — retries to maxAttempts', async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = async () => {
      callCount += 1;
      return { ok: false, status: 429 };
    };
    const result = await deliverWebhook(delivery, fetchImpl, { maxAttempts: 3 }, noDelay);
    expect(callCount).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.delivered).toBe(false);
    expect(result.lastStatus).toBe(429);
  });

  it('408 (request timeout) is retriable — retries to maxAttempts', async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = async () => {
      callCount += 1;
      return { ok: false, status: 408 };
    };
    const result = await deliverWebhook(delivery, fetchImpl, { maxAttempts: 3 }, noDelay);
    expect(callCount).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.delivered).toBe(false);
    expect(result.lastStatus).toBe(408);
  });
});
