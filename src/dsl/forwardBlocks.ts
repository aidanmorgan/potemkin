import type { Patch } from './patches.js';
import { parsePointer } from './patches.js';

// Translators for the forward-blocks the plugin merges into Specmatic.
// The functions are pure data transformations that downstream Kotlin code
// (or a TS-side embed) consumes; the engine itself never executes them.

export interface WorkflowIdEntry {
  readonly extract: string;
  readonly use: string;
}

export interface WorkflowConfig {
  readonly ids: Record<string, WorkflowIdEntry>;
}

// Validate the shape of `workflow: { ids: { name: { extract, use } } }`.
// Returns the validated config; throws on shape mismatch.
export function validateWorkflowForward(raw: unknown): WorkflowConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('workflow: must be an object');
  }
  const ids = (raw as { ids?: unknown }).ids;
  if (ids === undefined || ids === null || typeof ids !== 'object') {
    throw new Error('workflow.ids: must be an object');
  }
  const out: Record<string, WorkflowIdEntry> = {};
  for (const [k, v] of Object.entries(ids as Record<string, unknown>)) {
    if (v === null || typeof v !== 'object') {
      throw new Error(`workflow.ids.${k}: must be { extract, use }`);
    }
    const obj = v as { extract?: unknown; use?: unknown };
    if (typeof obj.extract !== 'string') {
      throw new Error(`workflow.ids.${k}.extract: must be a JSONPath string`);
    }
    if (typeof obj.use !== 'string') {
      throw new Error(`workflow.ids.${k}.use: must be a JSONPath string`);
    }
    out[k] = { extract: obj.extract, use: obj.use };
  }
  return { ids: out };
}

export interface GovernanceConfig {
  readonly report?: {
    readonly successCriteria?: {
      readonly minCoverage?: number;
      readonly excludedEndpoints?: readonly string[];
    };
  };
  readonly successCriterion?: string;
}

export function validateGovernanceForward(raw: unknown): GovernanceConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('governance: must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof GovernanceConfig]: GovernanceConfig[K] } = {};
  if (obj['report'] !== undefined) {
    if (obj['report'] === null || typeof obj['report'] !== 'object') {
      throw new Error('governance.report: must be an object');
    }
    out.report = obj['report'] as GovernanceConfig['report'];
  }
  if (obj['successCriterion'] !== undefined) {
    if (typeof obj['successCriterion'] !== 'string') {
      throw new Error('governance.successCriterion: must be a string');
    }
    out.successCriterion = obj['successCriterion'];
  }
  return out;
}

// Translate RFC 6902 patches against the OpenAPI spec document into the
// `actions[]` shape Specmatic's Overlay consumes: each patch becomes a
// { target: <JSONPath>, update | remove: <value> } action. move/copy
// are unrolled into pairs of remove + add at translation time.

export interface OverlayAction {
  readonly target: string;
  readonly update?: unknown;
  readonly remove?: true;
}

export function translateOverlayPatches(patches: readonly Patch[]): OverlayAction[] {
  const out: OverlayAction[] = [];
  for (const p of patches) {
    switch (p.op) {
      case 'add':
      case 'replace':
        out.push({ target: pointerToJsonPath(p.path), update: p.value });
        break;
      case 'remove':
        out.push({ target: pointerToJsonPath(p.path), remove: true });
        break;
      case 'move':
      case 'copy': {
        const fromTarget = pointerToJsonPath(p.from);
        const toTarget = pointerToJsonPath(p.path);
        if (p.op === 'move') {
          out.push({ target: fromTarget, remove: true });
        }
        // For copy we'd need the source value at runtime; we synthesise an
        // action whose update is null and rely on Specmatic to supply the
        // copied value. Stage 4 plugin translator can swap in a richer
        // strategy that reads the spec doc before translating.
        out.push({ target: toTarget, update: null });
        break;
      }
      default:
        // Potemkin extensions don't apply to spec-doc overlays.
        throw new Error(`Overlay translation only supports RFC 6902 ops; got '${p.op}'`);
    }
  }
  return out;
}

function pointerToJsonPath(pointer: string): string {
  const segs = parsePointer(pointer);
  if (segs.length === 0) return '$';
  return '$.' + segs.join('.');
}

// Forward-block precedence merger. Scalars from `potemkin` override the
// matching scalar from `specmatic`; lists concatenate AFTER specmatic's
// entries; objects merge per key recursively.

export function mergeForwardBlock<T extends Record<string, unknown>>(
  specmatic: T | undefined,
  potemkin: Partial<T> | undefined,
): T {
  if (specmatic === undefined && potemkin === undefined) return {} as T;
  if (specmatic === undefined) return { ...(potemkin as T) };
  if (potemkin === undefined) return { ...specmatic };
  const result: Record<string, unknown> = { ...specmatic };
  for (const [k, v] of Object.entries(potemkin)) {
    const existing = result[k];
    if (Array.isArray(existing) && Array.isArray(v)) {
      result[k] = [...existing, ...v];
    } else if (
      existing !== null &&
      typeof existing === 'object' &&
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(existing) &&
      !Array.isArray(v)
    ) {
      result[k] = mergeForwardBlock(
        existing as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else if (v !== undefined) {
      result[k] = v;
    }
  }
  return result as T;
}
