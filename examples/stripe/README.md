# Stripe — stateful Potemkin simulation

A local Potemkin recreation of selected Stripe test-mode payment behavior,
implemented statefully and contract-bound with Specmatic against the **vendored
Stripe OpenAPI** (`openapi/stripe-official.json`, ~414 paths). Object shapes,
ids (`cus_`/`prod_`/`price_`/`pi_`/`ch_`/`re_`), the
`object`/`created`/`livemode` envelope, the PaymentIntent state machine, and the
form-encoded request / JSON response convention follow the contract and the
documented Stripe surface.

Only six resources (customer, product, price, payment_intent, charge, refund) are
simulated statefully; every other Stripe path the contract declares is served by
the fallback policy (501 Not Implemented), which is expected for a real, full-surface spec.

## Layout

```
examples/stripe/
  openapi/stripe-official.json  # the vendored contract Specmatic enforces
  potemkin.yml                  # wiring: dsl modules + typescript scan + specmatic
  specmatic.yaml                # Specmatic system-under-test config
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

| Resource      | File                           | Notes                                                                                                     |
| ------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Customer      | `customer.resource.yaml`       | CRUD, list/delete envelopes                                                                               |
| Product       | `product.resource.yaml`        | CRUD                                                                                                      |
| Price         | `price.resource.yaml`          | create/get/list/update — **no delete** (Stripe prices are deactivated, not deleted)                       |
| PaymentIntent | `payment-intent.resource.yaml` | **state machine**: create → confirm → capture/cancel, with `requires` guards on the sub-action operations |
| Charge        | `charge.resource.yaml`         | never POST-created — **materialised by an in-UoW reaction** on PaymentIntent confirm/capture              |
| Refund        | `refund.resource.yaml`         | create/get/list/update — a reaction accrues `amount_refunded` on the charge                               |

## Extension points (no framework changes)

Everything Stripe-specific is expressed through generic Potemkin YAML and CEL
extension points:

- **Prefixed ids** — `identity.creation.generate: "$concat('cus_', $uuidv7())"` mints `cus_…`.
- **Response shaping** — resource response policies and YAML response fields keep
  list and deleted-object envelopes contract-shaped.
- **Clock-aware `created`** — `$unix()` reads the engine clock, so the admin clock
  and the `X-Potemkin-Clock-Offset`
  control header shift `created` deterministically.
- **State machine guards** — `requires` blocks on the confirm/capture/cancel
  behaviors reject invalid transitions (e.g. confirming a succeeded intent).
- **Reactions** — Charge/Refund are choreographed in-UoW from PaymentIntent/Refund
  events; no source coupling.

The event log is available through Potemkin's `/_admin/events` diagnostic
surface. Stripe event behavior is modeled locally by the configured event
catalog, reducers, and reactions; no test calls a Stripe API or consumes a
Stripe event feed.

## Running the tests

The tests are written from the **consumer side**: they drive the real Specmatic
stub (Specmatic enforces the OpenAPI contract; the plugin forwards to the engine)
and force known states **through the stub** — declarative `initialization:`
seeding, fault injection (a `card_declined` fault rule), `Idempotency-Key`
retries, and clock + reset.

```
cd plugin && ./gradlew shadowJar && cd ..   # build the plugin JAR (Java required)
pnpm run test:examples                       # e2e-tier; not part of `pnpm test`
```

## Contract-backed equivalence

`pnpm run test:equivalence` runs the model-driven traces against two local
Potemkin runtimes. The Stripe OpenAPI document is the contract oracle, and the
real consumer-facing behavior is proved separately through the Specmatic JVM
in `pnpm run test:examples` and `pnpm run test:e2e`. No Stripe credentials or
network API calls are involved.

The shared consumer-test client enforces this boundary at runtime: it accepts
only loopback HTTP endpoints, so a test cannot accidentally be pointed at a
provider URL.

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
