/**
 * Outbound webhook dispatch — HMAC-SHA256 signed HTTP POST on event emission.
 *
 * Scope note: this module implements the deterministic, network-free parts of
 * webhook dispatch — trigger matching, CEL payload templating, canonical body
 * serialisation, and HMAC-SHA256 signing — as pure, unit-testable functions.
 * The actual network send is performed by `deliverWebhook`, which is injectable
 * (the `fetchImpl` parameter) so callers and tests control transport. Delivery
 * IS wired: the UoW post-commit side-effects path (uow.ts) calls
 * `prepareWebhookDelivery` + `deliverWebhook` for each matched webhook, and
 * boot.ts wires a `createFetchWebhookTransport()`-backed transport by default,
 * giving at-least-once delivery with bounded retry/backoff on every commit.
 */

import { createHmac } from 'node:crypto';
import type { WebhookConfig } from '../dsl/types.js';
import type { DomainEvent, JsonValue } from '../types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import { CelPhase } from '../cel/phases.js';
import { POTEMKIN_WEBHOOK_SIGNATURE } from '../http/potemkinHeaders.js';
import { rootLogger } from '../observability/logger.js';

/**
 * Header carrying the webhook body signature, formatted `sha256=<hex>`.
 * Re-exported from the canonical X-Potemkin-* registry so the dispatcher and
 * any consumer share one source of truth for the header name.
 */
export const WEBHOOK_SIGNATURE_HEADER = POTEMKIN_WEBHOOK_SIGNATURE;

/** Return true when the webhook's trigger matches the emitted event/boundary/intent. */
export function webhookMatches(
  webhook: WebhookConfig,
  event: DomainEvent,
  boundary: string,
  intent: string,
  cel: CelEvaluator,
): boolean {
  const { trigger } = webhook;
  if (trigger.boundary !== undefined && trigger.boundary !== boundary) return false;
  if (trigger.intent !== undefined && trigger.intent !== intent) return false;

  const celCtx: Record<string, unknown> = {
    event: event as unknown as Record<string, unknown>,
    payload: event.payload,
  };
  try {
    return cel.evaluate(trigger.condition, celCtx, CelPhase.Behavior) === true;
  } catch (err) {
    rootLogger().warn(
      { webhook: webhook.name, condition: trigger.condition, err },
      'Webhook trigger condition CEL failed — treating as no match',
    );
    return false;
  }
}

/** Resolve the destination URL (CEL string expression or literal). */
export function resolveWebhookUrl(
  webhook: WebhookConfig,
  event: DomainEvent,
  cel: CelEvaluator,
): string {
  const celCtx: Record<string, unknown> = {
    event: event as unknown as Record<string, unknown>,
    payload: event.payload,
  };
  try {
    const resolved = cel.evaluate(webhook.url, celCtx, CelPhase.Behavior);
    if (typeof resolved === 'string') return resolved;
  } catch (err) {
    rootLogger().warn(
      { webhook: webhook.name, url: webhook.url, err },
      'Webhook url CEL failed — falling back to literal url',
    );
  }
  return webhook.url;
}

/** Build the webhook payload by evaluating each templated value against the event. */
export function buildWebhookPayload(
  webhook: WebhookConfig,
  event: DomainEvent,
  cel: CelEvaluator,
): JsonValue {
  if (!webhook.payload) return {};
  const celCtx: Record<string, unknown> = {
    event: event as unknown as Record<string, unknown>,
    payload: event.payload,
  };
  const out: Record<string, JsonValue> = {};
  for (const [key, expr] of Object.entries(webhook.payload)) {
    try {
      // Payload values use the `${expr}` DSL micro-syntax.
      out[key] = cel.evaluateDslValue(expr, celCtx, CelPhase.Behavior) as JsonValue;
    } catch (err) {
      rootLogger().warn(
        { webhook: webhook.name, key, expr, err },
        'Webhook payload CEL failed — setting field to null',
      );
      out[key] = null;
    }
  }
  return out;
}

/**
 * Canonical JSON serialisation used both as the request body and as the HMAC
 * signing input, so a recipient can recompute the signature deterministically.
 */
export function serialiseWebhookBody(payload: JsonValue): string {
  return JSON.stringify(payload);
}

/** Compute the hex HMAC-SHA256 signature of `body` under `secret`. */
export function signWebhookBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export interface WebhookDelivery {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

/**
 * Prepare a fully-resolved, signed delivery for a matched webhook + event.
 * Returns null when the webhook does not match.
 */
export function prepareWebhookDelivery(
  webhook: WebhookConfig,
  event: DomainEvent,
  boundary: string,
  intent: string,
  cel: CelEvaluator,
): WebhookDelivery | null {
  if (!webhookMatches(webhook, event, boundary, intent, cel)) return null;

  const url = resolveWebhookUrl(webhook, event, cel);
  const payload = buildWebhookPayload(webhook, event, cel);
  const body = serialiseWebhookBody(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (webhook.secret) {
    headers[WEBHOOK_SIGNATURE_HEADER] = `sha256=${signWebhookBody(body, webhook.secret)}`;
  }
  return { url, body, headers };
}

/** Minimal fetch-like transport so delivery can be tested without a real network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Deliver a prepared webhook with bounded retry. Returns the number of attempts
 * made and whether delivery ultimately succeeded. Never throws — transport
 * failures are surfaced via the result so the caller can log/ignore them.
 */
export async function deliverWebhook(
  delivery: WebhookDelivery,
  fetchImpl: FetchLike,
  retry?: { maxAttempts?: number; delayMs?: number },
): Promise<{ attempts: number; delivered: boolean; lastStatus?: number }> {
  const maxAttempts = Math.max(1, retry?.maxAttempts ?? 1);
  const delayMs = retry?.delayMs;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(delivery.url, {
        method: 'POST',
        headers: delivery.headers,
        body: delivery.body,
      });
      lastStatus = res.status;
      if (res.ok) return { attempts: attempt, delivered: true, lastStatus };
    } catch (err) {
      // Treat a transport throw as a failed attempt.
      rootLogger().warn(
        { url: delivery.url, attempt, maxAttempts, err },
        'Webhook delivery transport threw — counting as a failed attempt',
      );
    }
    // Back off between attempts only — no delay after the final attempt.
    if (delayMs !== undefined && delayMs > 0 && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { attempts: maxAttempts, delivered: false, ...(lastStatus !== undefined ? { lastStatus } : {}) };
}
