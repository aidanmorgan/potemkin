// YAML schema validators for potemkin.yaml and boundary modules. All keys
// are camelCase; snake_case and the removed `assign:`/`append:` reducer
// shapes throw BOOT_ERR_REMOVED_SYNTAX with the canonical replacement.
// Unknown top-level keys in potemkin.yaml are rejected with a Levenshtein
// "did you mean?" suggestion.

import { BootError } from '../errors.js';
import { assertNoRemovedReducerKeys } from './removedSyntax.js';
import type { Patch } from './patches.js';
import type {
  DeclaredComputedField,
  DeclaredInternalField,
  EventDecl,
  ReducerDecl,
  FieldType,
} from './schemaInference.js';

// ---------------------------------------------------------------------------
// Top-level potemkin.yaml shape
// ---------------------------------------------------------------------------

export interface PotemkinConfigTypescriptScanEntry {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

export interface PotemkinConfigTypescript {
  readonly scan: readonly PotemkinConfigTypescriptScanEntry[];
  readonly watch?: boolean;
  readonly watchDebounceMs?: number;
}

export interface PotemkinConfigPlugin {
  readonly engine?: { readonly url?: string; readonly timeoutMs?: number };
  readonly controlPort?: number;
  readonly circuitBreaker?: Record<string, unknown>;
}

export interface PotemkinConfigSeed {
  readonly description?: string;
  readonly request: { readonly method: string; readonly path: string };
  readonly base: 'contract' | 'empty';
  readonly patches: readonly Patch[];
}

export interface PotemkinConfigWorkflow {
  readonly ids?: Record<string, { extract: string; use: string }>;
}

export interface PotemkinConfigOverlay {
  readonly patches: readonly Patch[];
}

export interface PotemkinConfigGovernance {
  readonly report?: Record<string, unknown>;
  readonly successCriterion?: string;
}

export interface PotemkinConfig {
  readonly version: number;
  readonly specmatic: string;
  readonly modules: readonly string[];
  readonly typescript?: PotemkinConfigTypescript;
  readonly plugin?: PotemkinConfigPlugin;
  readonly seeds?: readonly PotemkinConfigSeed[];
  readonly workflow?: PotemkinConfigWorkflow;
  readonly overlay?: PotemkinConfigOverlay;
  readonly governance?: PotemkinConfigGovernance;
}

// ---------------------------------------------------------------------------
// Boundary module shape (new format)
// ---------------------------------------------------------------------------

export interface BoundaryBehavior {
  readonly intent: string;
  readonly match?: Record<string, unknown>;
  readonly emit?: readonly { name: string; template?: Record<string, string> }[];
  readonly dispatch?: readonly {
    boundary: string;
    intent: string;
    targetId?: string;
    template?: Record<string, string>;
  }[];
}

export interface BoundaryReducer extends ReducerDecl {}

export interface BoundaryHateoasEntry {
  readonly rel: string;
  readonly href: string;
}

export interface BoundaryDeprecation {
  readonly sunset?: string;
  readonly replacement?: string;
}

export interface BoundaryModule {
  readonly boundary: string;
  readonly specId: string;
  readonly contractPath: string;
  readonly methods?: readonly string[];
  readonly outOfContract?: boolean;
  readonly events: readonly EventDecl[];
  readonly behaviors?: readonly BoundaryBehavior[];
  readonly reducers?: readonly BoundaryReducer[];
  readonly state?: {
    readonly computed?: readonly DeclaredComputedField[];
    readonly internal?: readonly DeclaredInternalField[];
  };
  readonly hateoas?: readonly BoundaryHateoasEntry[];
  readonly deprecation?: BoundaryDeprecation;
  readonly mask?: readonly string[];
  readonly strict?: boolean;
}

export interface GlobalModule {
  readonly sagas?: readonly unknown[];
  readonly idempotency?: Record<string, unknown>;
  readonly auth?: Record<string, unknown>;
  readonly hateoas?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POTEMKIN_TOP_LEVEL_KEYS = [
  'version',
  'specmatic',
  'modules',
  'typescript',
  'plugin',
  'seeds',
  'workflow',
  'overlay',
  'governance',
] as const;

export const BOUNDARY_TOP_LEVEL_KEYS = [
  'boundary',
  'specId',
  'contractPath',
  'methods',
  'outOfContract',
  'events',
  'behaviors',
  'reducers',
  'state',
  'hateoas',
  'deprecation',
  'mask',
  'strict',
] as const;

// snake_case → camelCase replacement table. Any of these keys at parse
// time produces BOOT_ERR_REMOVED_SYNTAX naming the replacement.
export const REMOVED_KEY_MAP: Record<string, string> = {
  event_catalog: 'events',
  payload_template: 'template',
  state_schema: 'state',
  dispatch_commands: 'dispatch',
  contract_path: 'contractPath',
  depends_on: 'dependsOn',
  out_of_contract: 'outOfContract',
  spec_id: 'specId',
  seed_expectations: 'seeds',
  derived_projections: 'derivedProjections',
};

// ---------------------------------------------------------------------------
// Validation entrypoints
// ---------------------------------------------------------------------------

export interface ValidationContext {
  /** Source description for error messages (file path, "potemkin.yaml", etc.). */
  readonly source: string;
}

export function validatePotemkinConfig(raw: unknown, ctx: ValidationContext): PotemkinConfig {
  if (!isObject(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: root must be an object`,
      { source: ctx.source },
    );
  }

  rejectSnakeCaseKeys(raw, ctx.source);

  for (const k of Object.keys(raw)) {
    if (!(POTEMKIN_TOP_LEVEL_KEYS as readonly string[]).includes(k)) {
      const suggestion = closestKey(k, POTEMKIN_TOP_LEVEL_KEYS);
      throw new BootError(
        'BOOT_ERR_UNKNOWN_KEY',
        `${ctx.source}: unknown top-level key "${k}"${
          suggestion ? ` — did you mean "${suggestion}"?` : ''
        }`,
        { source: ctx.source, key: k, ...(suggestion ? { suggestion } : {}) },
      );
    }
  }

  if (typeof raw['version'] !== 'number') {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "version" must be a number`,
      { source: ctx.source },
    );
  }
  if (typeof raw['specmatic'] !== 'string') {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "specmatic" must be a string path`,
      { source: ctx.source },
    );
  }
  const modules = raw['modules'];
  if (!Array.isArray(modules) || modules.length === 0 || modules.some((m) => typeof m !== 'string')) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "modules" must be a non-empty array of glob strings`,
      { source: ctx.source },
    );
  }

  return {
    version: raw['version'] as number,
    specmatic: raw['specmatic'] as string,
    modules: modules as readonly string[],
    typescript: raw['typescript'] as PotemkinConfigTypescript | undefined,
    plugin: raw['plugin'] as PotemkinConfigPlugin | undefined,
    seeds: raw['seeds'] as readonly PotemkinConfigSeed[] | undefined,
    workflow: raw['workflow'] as PotemkinConfigWorkflow | undefined,
    overlay: raw['overlay'] as PotemkinConfigOverlay | undefined,
    governance: raw['governance'] as PotemkinConfigGovernance | undefined,
  };
}

export function validateBoundaryModule(raw: unknown, ctx: ValidationContext): BoundaryModule {
  if (!isObject(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: boundary module root must be an object`,
      { source: ctx.source },
    );
  }

  rejectSnakeCaseKeys(raw, ctx.source);

  if (typeof raw['boundary'] !== 'string' || (raw['boundary'] as string).length === 0) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "boundary" is required and must be a non-empty string`,
      { source: ctx.source },
    );
  }

  if (typeof raw['specId'] !== 'string' || (raw['specId'] as string).length === 0) {
    throw new BootError(
      'BOOT_ERR_MISSING_SPEC_ID',
      `${ctx.source}: boundary "${raw['boundary']}" is missing required "specId"`,
      { source: ctx.source, boundary: raw['boundary'] as string },
    );
  }

  if (typeof raw['contractPath'] !== 'string') {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "contractPath" is required and must be a string`,
      { source: ctx.source },
    );
  }

  const events = raw['events'];
  if (!Array.isArray(events)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "events" must be an array`,
      { source: ctx.source },
    );
  }

  const reducers = raw['reducers'];
  if (reducers !== undefined && !Array.isArray(reducers)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "reducers" must be an array`,
      { source: ctx.source },
    );
  }
  if (Array.isArray(reducers)) {
    for (const r of reducers) {
      if (!isObject(r)) continue;
      // Single removed-key policy shared with the in-memory validator.
      assertNoRemovedReducerKeys(r, ctx.source);
    }
  }

  // Unknown keys at boundary level are tolerated for forward-compat —
  // callers log INFO when they see fields outside the canonical set.
  return raw as unknown as BoundaryModule;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rejectSnakeCaseKeys(raw: Record<string, unknown>, source: string): void {
  for (const k of Object.keys(raw)) {
    if (k in REMOVED_KEY_MAP) {
      throw new BootError(
        'BOOT_ERR_REMOVED_SYNTAX',
        `${source}: key "${k}" was renamed to "${REMOVED_KEY_MAP[k]}"`,
        { source, removed: k, replacement: REMOVED_KEY_MAP[k] },
      );
    }
  }
}

/**
 * Return the closest match from `candidates` within Levenshtein distance 3,
 * or null. Plain implementation — no n^2 worry at this input size.
 */
function closestKey(needle: string, candidates: readonly string[]): string | null {
  let best: { key: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(needle, c);
    if (d <= 3 && (!best || d < best.d)) best = { key: c, d };
  }
  return best ? best.key : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Re-export for callers that pair validation with schema inference.
export type { Patch, FieldType };
