/**
 * Scanned @Script extensions for the Stripe simulation.
 *
 * These are the framework's user-extension mechanism in action: each @Script is
 * registered at boot and referenced from the YAML DSL as `ts:<id>`. Nothing
 * Stripe-specific lives in the engine — the Stripe-shaped behaviour (prefixed
 * ids, Unix `created` timestamps) is injected here, at the example, through
 * generic extension points (identity.creation.generate, payload_template, ...).
 */
import { Script, type ScriptContext, type ResponseScriptResult } from '@potemkin/sdk';

/** Stripe object ids are `<prefix>_<token>` (e.g. cus_, pi_, ch_). */
function stripeId(prefix: string, ctx: ScriptContext): string {
  return `${prefix}_${ctx.helpers.uuid().replace(/-/g, '')}`;
}

/**
 * Shared `response: ts:<id>` transform giving every resource Stripe-faithful
 * responses through the engine's generic response extension point:
 *   - create   → 200 (Stripe returns 200, not the engine default 201)
 *   - delete   → 200 + the `{id, object, deleted:true}` deleted object
 *   - list     → the `{object:"list", data, has_more, url}` list envelope
 *   - retrieve/update → unchanged (the resource object, already faithful)
 */
function stripeResponse(objectName: string, listUrl: string, ctx: ScriptContext): ResponseScriptResult {
  const op = ctx.operationId ?? '';
  const body = ctx.response?.body ?? null;
  if (op.startsWith('create')) return { status: 200 };
  if (op.startsWith('delete')) {
    const b = (body ?? {}) as Record<string, unknown>;
    return { status: 200, body: { id: b['id'], object: objectName, deleted: true } };
  }
  if (op.startsWith('list')) {
    return { body: { object: 'list', url: listUrl, has_more: false, data: Array.isArray(body) ? body : [] } };
  }
  return {};
}

/** Current time as integer Unix seconds — the format of every Stripe `created`. */
@Script('unixNow')
export class UnixNow {
  run(_ctx: ScriptContext): number {
    return Math.floor(Date.now() / 1000);
  }
}

// ── Per-resource id generators (identity.creation.generate: ts:<id>) ──────────

@Script('customerId')
export class CustomerId {
  run(ctx: ScriptContext): string { return stripeId('cus', ctx); }
}

@Script('productId')
export class ProductId {
  run(ctx: ScriptContext): string { return stripeId('prod', ctx); }
}

@Script('priceId')
export class PriceId {
  run(ctx: ScriptContext): string { return stripeId('price', ctx); }
}

@Script('paymentIntentId')
export class PaymentIntentId {
  run(ctx: ScriptContext): string { return stripeId('pi', ctx); }
}

@Script('chargeId')
export class ChargeId {
  run(ctx: ScriptContext): string { return stripeId('ch', ctx); }
}

@Script('refundId')
export class RefundId {
  run(ctx: ScriptContext): string { return stripeId('re', ctx); }
}

// ── Per-resource response transforms (response: ts:<id>) ──────────────────────

@Script('customerResponse')
export class CustomerResponse {
  run(ctx: ScriptContext): ResponseScriptResult { return stripeResponse('customer', '/v1/customers', ctx); }
}
