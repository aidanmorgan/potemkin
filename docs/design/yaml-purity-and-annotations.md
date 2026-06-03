# Design spec: YAML purity (block style, no inline TypeScript)

Status: proposed. Tracking: epic `potemkin-<epic>` and increments below.

Two corrections, with the same intent: YAML files should read as YAML and contain only
declarative configuration, never embedded code or JSON-shaped flow syntax.

## Correction A — block YAML, no inline JSON/flow

Examples and fixtures currently use flow style in many places, e.g.
`match: { operationId: createLead, condition: "true" }`, `retry: { maxAttempts: 3 }`,
`- { op: add, path: /leads, value: "${0}" }`. Flow mappings/sequences are valid YAML but read
like JSON. We want block style everywhere a developer reads the DSL.

Scope: every YAML fence in `README.md` and `docs/**/*.md`, and every `*.yaml` under
`tests/fixtures/**`. The change is purely syntactic — the parsed structure is identical — so it is
verified by the test suite staying green. CEL `${...}` strings are untouched.

Optional guard: a small repo check that flags flow-style mappings/sequences inside DSL YAML so the
style does not regress. Treated as a follow-up, not a blocker.

## Correction B — no inline TypeScript; annotation-based discovery

Today an inline script is declared in YAML as `scripts: [{ name: computeScore, code: | <TS source> }]`
and referenced with the `ts:computeScore` sentinel. We want the YAML to carry only the **id**; the
function is authored in a scanned `.ts` file and discovered by an annotation, exactly as TypeScript
reducers already work.

The project already has the mechanism: `@potemkin/sdk` exposes a `@Reducer({ boundary, event })`
class decorator; scanned `.ts` files self-register into the SDK registry on import; the scanner
(`src/dsl/typescriptScanner.ts`) drains `sdkRegistry.snapshot()`. We extend the same pattern to
scripts.

### Target shape

```ts
// scripts/computeScore.ts (scanned via potemkin.yaml typescript.scan)
import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('computeScore')                 // the annotation/id the YAML references
export class ComputeScore {
  run(ctx: ScriptContext): number {
    const base: Record<string, number> = { REFERRAL: 80, WEBSITE: 50 };
    return base[ctx.command.payload.source as string] ?? 30;
  }
}
```

```yaml
# event_catalog entry — references the annotation id only, no code
payload_template:
  score: "ts:computeScore"
# No scripts: block. No inline `code:`.
```

### Decisions

- **Annotation form**: a class decorator `@Script(id)`, mirroring `@Reducer`, because free-function
  decorators are not valid TS and the project already standardised on class decorators for scanned
  code. A `defineScript(id, fn)` functional helper is provided alongside for parity with the
  `reducer()` helper.
- **Discovery**: the existing `typescript.scan` globs in `potemkin.yaml` are scanned at boot; the
  scanner drains a script registry keyed by id, alongside the reducer registry.
- **Resolution**: the `ts:<id>` sentinel resolves against the scanned script registry; an unknown id
  halts boot with a clear `BOOT_ERR_DSL_REFERENCE`.
- **Removal of inline code**: the inline `scripts: [{ name, code }]` form is removed. Using `code:`
  (or the `scripts:` block) halts boot with `BOOT_ERR_REMOVED_SYNTAX` and a migration message. The
  sandbox/transpile machinery is retained — it now executes scanned annotated scripts rather than
  inline strings.
- **Sandbox unchanged**: scripts still run in the `node:vm` sandbox under the 50 ms budget; only the
  source of the code (a scanned annotated class vs an inline YAML string) changes.

## Process note (applies to every bead)

Every increment below — and every other bead from here on — closes only after a **new adversarial
sub-agent** verifies that the change is comprehensive, that all associated tests were updated, and
that each acceptance criterion is objectively and quantitatively met. A failing review reopens the
bead.

## Delivery increments

- **A1** — Convert all YAML fences in `README.md` and `docs/**/*.md` to block style.
- **A2** — Convert inline-flow YAML in `tests/fixtures/**` to block style; suite stays green.
- **B1** — Add `@Script(id)` decorator + `defineScript(id, fn)` helper + a script registry drained by the scanner.
- **B2** — Resolve `ts:<id>` against the scanned script registry; unknown id → boot error; sandbox executes scanned scripts.
- **B3** — Remove inline `scripts[].code`; `code:`/`scripts:` halts boot with `BOOT_ERR_REMOVED_SYNTAX`.
- **B4** — Migrate every fixture using inline scripts (crm `computeScore`, others) to scanned annotated `.ts` files; update `typescript.scan` and the YAML; update affected tests.
- **B5** — Docs: `docs/dsl.md` §10 and the README "running custom logic" recipe describe the annotation approach; no inline-TS example remains.
- **B6** — E2E: the inline-typescript example (`11`) or a new engine-only suite demonstrates annotation-based script discovery (YAML holds only the id).
