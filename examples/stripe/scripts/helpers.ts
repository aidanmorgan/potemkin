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
 *
 * The real Stripe OpenAPI uses PascalCase operationIds (e.g. PostCustomers,
 * GetCustomers, DeleteCustomersCustomer), so the create/list op names are passed
 * explicitly per resource and the delete branch keys off the `Delete` prefix.
 */
function stripeResponse(
  objectName: string,
  listUrl: string,
  createOp: string,
  listOp: string,
  ctx: ScriptContext,
): ResponseScriptResult {
  const op = ctx.operationId ?? '';
  const body = ctx.response?.body ?? null;
  if (op === createOp) return { status: 200 };
  if (op.startsWith('Delete')) {
    const b = (body ?? {}) as Record<string, unknown>;
    return { status: 200, body: { id: b['id'], object: objectName, deleted: true } };
  }
  if (op === listOp) {
    return { body: { object: 'list', url: listUrl, has_more: false, data: Array.isArray(body) ? body : [] } };
  }
  return {};
}

/** Current time as integer Unix seconds — the format of every Stripe `created`.
 *  Uses the engine clock (ctx.helpers.now) so the admin clock and the
 *  X-Potemkin-Clock-Offset control header shift `created` deterministically. */
@Script('unixNow')
export class UnixNow {
  run(ctx: ScriptContext): number {
    return Math.floor(new Date(ctx.helpers.now()).getTime() / 1000);
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
  run(ctx: ScriptContext): ResponseScriptResult { return stripeResponse('customer', '/v1/customers', 'PostCustomers', 'GetCustomers', ctx); }
}

@Script('productResponse')
export class ProductResponse {
  run(ctx: ScriptContext): ResponseScriptResult { return stripeResponse('product', '/v1/products', 'PostProducts', 'GetProducts', ctx); }
}

@Script('priceResponse')
export class PriceResponse {
  run(ctx: ScriptContext): ResponseScriptResult { return stripeResponse('price', '/v1/prices', 'PostPrices', 'GetPrices', ctx); }
}

@Script('paymentIntentResponse')
export class PaymentIntentResponse {
  run(ctx: ScriptContext): ResponseScriptResult { return stripeResponse('payment_intent', '/v1/payment_intents', 'PostPaymentIntents', 'GetPaymentIntents', ctx); }
}

@Script('chargeResponse')
export class ChargeResponse {
  run(ctx: ScriptContext): ResponseScriptResult { return stripeResponse('charge', '/v1/charges', 'PostCharges', 'GetCharges', ctx); }
}

@Script('refundResponse')
export class RefundResponse {
  run(ctx: ScriptContext): ResponseScriptResult { return stripeResponse('refund', '/v1/refunds', 'PostRefunds', 'GetRefunds', ctx); }
}
