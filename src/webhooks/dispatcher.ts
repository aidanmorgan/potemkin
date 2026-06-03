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
 * boot.ts wires a `createFetchWebhookTransport()`-backed transport by default.
 *
 * Default retry behaviour (when no per-webhook `retry` block is configured):
 *   - maxAttempts: 3 (at-least-once on transient failures)
 *   - delay:       exponential backoff with full-jitter —
 *                  `base * 2^(attempt-1) * (0.5 + jitter)`, capped at 30 s,
 *                  where `base` defaults to 1000 ms and `jitter` is injectable
 *                  (defaults to Math.random) to keep tests deterministic.
 * Per-webhook `retry.maxAttempts` / `retry.delayMs` override the defaults.
 */

import { createHmac } from 'node:crypto';
import retry from 'async-retry';
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

/** Maximum backoff cap in milliseconds (30 seconds). */
const MAX_BACKOFF_MS = 30_000;

/** Default number of delivery attempts when no per-webhook retry block is set. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Default base delay in milliseconds for exponential backoff. */
const DEFAULT_BASE_DELAY_MS = 1_000;

/**
 * Compute the backoff delay for a given attempt using full-jitter exponential
 * backoff: `base * 2^(attempt-1) * (0.5 + jitter)`, capped at MAX_BACKOFF_MS.
 * `attempt` is 1-based; jitter is a function returning a value in [0, 0.5).
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  jitterFn: () => number,
): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  return Math.round(capped * (0.5 + jitterFn()));
}

/**
 * Options that control the retry behaviour inside `deliverWebhook`.
 * These map directly to `async-retry` options and are exposed as a test seam
 * so callers can set `minTimeout: 0, maxTimeout: 0, randomize: false` to get
 * instant, deterministic backoff in tests.
 */
export interface DeliverRetryOverrides {
  readonly minTimeout?: number;
  readonly maxTimeout?: number;
  readonly factor?: number;
  readonly randomize?: boolean;
}

/**
 * Deliver a prepared webhook with bounded retry and exponential backoff + jitter
 * via `async-retry`.
 *
 * Returns the number of attempts made and whether delivery ultimately succeeded.
 * Never throws — transport failures are surfaced via the result so the caller
 * can log/ignore them.
 *
 * @param retryConfig    Per-webhook `retry` block from the DSL (maxAttempts / delayMs).
 * @param retryOverrides async-retry option overrides for test determinism
 *                       (e.g. `{ minTimeout: 0, maxTimeout: 0, randomize: false }`).
 */
export async function deliverWebhook(
  delivery: WebhookDelivery,
  fetchImpl: FetchLike,
  retryConfig?: { maxAttempts?: number; delayMs?: number },
  retryOverrides?: DeliverRetryOverrides,
): Promise<{ attempts: number; delivered: boolean; lastStatus?: number }> {
  const maxAttempts = Math.max(1, retryConfig?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = retryConfig?.delayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastStatus: number | undefined;
  let attempts = 0;

  try {
    await retry(
      async (_bail, attemptNumber) => {
        attempts = attemptNumber;
        const res = await fetchImpl(delivery.url, {
          method: 'POST',
          headers: delivery.headers,
          body: delivery.body,
        });
        lastStatus = res.status;
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      },
      {
        retries: maxAttempts - 1,
        minTimeout: retryOverrides?.minTimeout ?? baseDelayMs,
        maxTimeout: retryOverrides?.maxTimeout ?? MAX_BACKOFF_MS,
        factor: retryOverrides?.factor ?? 2,
        randomize: retryOverrides?.randomize ?? true,
        onRetry: (err: Error, attempt: number) => {
          rootLogger().warn(
            { url: delivery.url, attempt, maxAttempts, err: err.message },
            'Webhook delivery failed — retrying',
          );
        },
      },
    );
    return { attempts, delivered: true, lastStatus };
  } catch (err) {
    rootLogger().warn(
      { url: delivery.url, attempts, maxAttempts, err },
      'Webhook delivery failed after all attempts',
    );
    return { attempts, delivered: false, ...(lastStatus !== undefined ? { lastStatus } : {}) };
  }
}
