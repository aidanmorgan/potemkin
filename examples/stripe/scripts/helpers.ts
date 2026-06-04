/**
 * Scanned @Script extensions for the Stripe simulation.
 *
 * These are the framework's user-extension mechanism in action: each @Script is
 * registered at boot and referenced from the YAML DSL as `ts:<id>`. Nothing
 * Stripe-specific lives in the engine — the Stripe-shaped behaviour (prefixed
 * ids, Unix `created` timestamps) is injected here, at the example, through
 * generic extension points (identity.creation.generate, payload_template, ...).
 */
import { Script, type ScriptContext } from '@potemkin/sdk';

/** Stripe object ids are `<prefix>_<token>` (e.g. cus_, pi_, ch_). */
function stripeId(prefix: string, ctx: ScriptContext): string {
  return `${prefix}_${ctx.helpers.uuid().replace(/-/g, '')}`;
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
