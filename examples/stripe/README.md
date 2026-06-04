# Stripe — stateful Potemkin simulation

A behaviourally-equivalent slice of the Stripe API (core payments) implemented
statefully with Potemkin and contract-bound with Specmatic. Object shapes, ids
(`cus_`/`prod_`/`price_`/`pi_`/`ch_`/`re_`), the `object`/`created`/`livemode`
envelope, the PaymentIntent state machine, and the form-encoded request / JSON
response convention all follow the real Stripe API.

## Layout

```
examples/stripe/
  openapi/stripe-core.yaml   # the contract Specmatic enforces
  potemkin.yaml              # wiring: dsl modules + typescript scan + specmatic
  specmatic.yaml             # Specmatic system-under-test config
  scripts/helpers.ts         # @Script extensions (ids, response shaping, clock)
  dsl/                       # the simulation (boundaries / resources)
  tests/                     # consumer-side integration tests (full Specmatic stack)
```

## Resources

| Resource | Form | Notes |
|---|---|---|
| Customer | `customer.resource.yaml` (resource aggregate) | CRUD, list/delete envelopes |
| Product | `product.yaml` + `product-by-id.yaml` | CRUD |
| Price | `price.yaml` + `price-by-id.yaml` | create/get/list/update — **no delete** (Stripe prices are deactivated, not deleted) |
| PaymentIntent | `payment-intent*.yaml` (5 boundaries) | **state machine**: create → confirm → capture/cancel, with `requires` guards |
| Charge | `charge.yaml` + `charge-by-id.yaml` | never POST-created — **materialised by an in-UoW reaction** on PaymentIntent confirm/capture |
| Refund | `refund.yaml` + `refund-by-id.yaml` | create/get/list/update — a reaction accrues `amount_refunded` on the charge |

## Extension points (no framework changes)

Everything Stripe-specific is injected through generic Potemkin extension points,
defined as `@Script`s in `scripts/helpers.ts` and referenced from the DSL as
`ts:<id>`:

- **Prefixed ids** — `identity.creation.generate: "ts:customerId"` mints `cus_…`
  etc. via `ctx.helpers.uuid()`.
- **Response shaping** — `response: "ts:customerResponse"` returns Stripe-faithful
  responses through the generic response extension (200-on-create, the
  `{object:"list", data, …}` list envelope, the `{id, object, deleted:true}`
  deleted object). The transform runs inside the UoW before contract validation.
- **Clock-aware `created`** — `ts:unixNow` reads the engine clock
  (`ctx.helpers.now`), so the admin clock and the `X-Potemkin-Clock-Offset`
  control header shift `created` deterministically.
- **State machine guards** — `requires` blocks on the confirm/capture/cancel
  behaviors reject invalid transitions (e.g. confirming a succeeded intent).
- **Reactions** — Charge/Refund are choreographed in-UoW from PaymentIntent/Refund
  events; no source coupling.

## Running the tests

The tests are written from the **consumer side**: they drive the real Specmatic
stub (Specmatic enforces the OpenAPI contract; the plugin forwards to the engine)
and force known states **through the stub** — declarative `initialization:`
seeding, fault injection (a `card_declined` fault rule), `Idempotency-Key`
retries, and clock + reset.

```
cd plugin && ./gradlew shadowJar && cd ..   # build the plugin JAR (Java required)
npm run test:examples                        # e2e-tier; NOT part of `npm test`
```

Lint the simulation without starting any servers:

```
npm run lint:sim -- examples/stripe
```

## Documented deviations from real Stripe

These are intentional simplifications of the curated slice, not bugs:

- **Invalid state-machine transitions return HTTP 422** (Potemkin's
  precondition-failure convention) where Stripe returns 400. The error body still
  carries a `PAYMENT_INTENT_UNEXPECTED_STATE` code.
- **Refund `amount` is explicit** — a refund cannot read the charge's remaining
  balance across aggregates to default a full refund, so the amount is required.
- **`/v1/payouts`** is declared in the contract but deliberately unimplemented; it
  exercises the fallback policy (501 Not Implemented). Any other un-bounded Stripe
  path behaves the same.
