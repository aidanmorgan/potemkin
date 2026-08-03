# Contract error-body triage

Error shaping is resolved per matched operation and status, never once for an
entire OpenAPI document. `src/contract/responseSchema.ts` is the single lookup
implementation: `matchRoute` selects the operation, then the exact numeric
status key is tried before `default`. OpenAPI range keys such as `4XX` and
`5XX` are not indexed by the loader.

The current example contracts contain these declared response pairs:

| Contract | Declared pairs                                                                 | Error pairs relevant to runtime shaping             |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------------------- |
| CRM      | `200` × 26, `201` × 5, `400` × 9, `401` × 1, `403` × 1, `404` × 19, `422` × 13 | `400`, `401`, `403`, `404`, and `422`; no `default` |
| Stripe   | `200` × 586 and `default` × 587                                                | every operation's `default` response                |

CRM's 422 operations are:

- `POST /leads/{id}/contact`
- `POST /leads/{id}/qualify`
- `POST /leads/{id}/disqualify`
- `POST /leads/{id}/convert`
- `POST /campaigns`
- `PATCH /campaigns/{id}/activate`
- `PATCH /campaigns/{id}/pause`
- `POST /opportunities`
- `PATCH /opportunities/{id}/advance`
- `PATCH /opportunities/{id}/close`
- `POST /opportunities/{id}/line-items`
- `POST /leads/{id}/notes`
- `POST /calls/{id}/transcript`

A runtime status without an exact or `default` schema for the matched
operation is deliberately left generic. Shaping it would claim a response
the contract does not declare. This is especially important for CRM guard
failures: the 422 body is contract-shaped only for the thirteen operations
above. Stripe guard and runtime failures use the operation's `default` schema.

When a contract constrains its error code field, the optional flat map is
loaded from `examples/<example>/error-code-map.json`. Stripe maps engine error
codes to valid `api_error`, `idempotency_error`, or `invalid_request_error`
values; unmapped values use the first schema enum member while preserving the
engine code in the message. Boot lint and the shared builder both consume the
same map.

The direct gateway, Specmatic forwarding path, engine error shaping, and static
error lint all call the same `buildContractErrorBody`/`resolveResponseSchema`
implementation. Out-of-contract 404 responses have no matched operation and
are intentionally outside this shaping boundary.
