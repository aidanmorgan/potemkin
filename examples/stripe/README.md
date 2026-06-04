# Stripe — stateful Potemkin simulation

A behaviourally-equivalent slice of the Stripe API (core payments) implemented
statefully with Potemkin and contract-bound with Specmatic against the **real,
vendored Stripe OpenAPI** (`openapi/stripe-official.json`, ~414 paths). Object
shapes, ids (`cus_`/`prod_`/`price_`/`pi_`/`ch_`/`re_`), the
`object`/`created`/`livemode` envelope, the PaymentIntent state machine, and the
form-encoded request / JSON response convention all follow the real Stripe API.

Only six resources (customer, product, price, payment_intent, charge, refund) are
simulated statefully; every other Stripe path the contract declares is served by
the fallback policy (501 Not Implemented), which is why `lint:sim` emits many
`UNBOUNDED_OPERATION` warnings — that is expected for a real, full-surface spec.

## Layout

```
examples/stripe/
  openapi/stripe-official.json  # the real Stripe contract Specmatic enforces
  potemkin.yaml                 # wiring: dsl modules + typescript scan + specmatic
  specmatic.yaml                # Specmatic system-under-test config
  scripts/helpers.ts            # @Script extensions (ids, response shaping, clock)
  dsl/                          # the simulation (resource aggregates)
  tests/                        # consumer-side integration tests (full Specmatic stack)
```

## Resources

Every resource is a single **resource aggregate** (`*.resource.yaml`): the engine
expands one declaration into the per-path boundaries (collection, by-id,
sub-actions) it would otherwise be written by hand, resolving each
`operations: { op: <operationId> }` to its OpenAPI path. The operationIds are the
real Stripe PascalCase names (e.g. `PostCustomers`, `GetCustomers`,
`PostPaymentIntentsIntentConfirm`).

| Resource | File | Notes |
|---|---|---|
| Customer | `customer.resource.yaml` | CRUD, list/delete envelopes |
| Product | `product.resource.yaml` | CRUD |
| Price | `price.resource.yaml` | create/get/list/update — **no delete** (Stripe prices are deactivated, not deleted) |
| PaymentIntent | `payment-intent.resource.yaml` | **state machine**: create → confirm → capture/cancel, with `requires` guards on the sub-action operations |
| Charge | `charge.resource.yaml` | never POST-created — **materialised by an in-UoW reaction** on PaymentIntent confirm/capture |
| Refund | `refund.resource.yaml` | create/get/list/update — a reaction accrues `amount_refunded` on the charge |

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
- **Only six resources are simulated.** Every other Stripe path the real contract
  declares (e.g. `/v1/payouts`, subscriptions, invoices, …) is deliberately
  unimplemented and served by the fallback policy (501 Not Implemented); a path not
  in the contract at all is a 404. The smoke test asserts both via `/v1/payouts`
  and `/v1/not_a_stripe_path`.
