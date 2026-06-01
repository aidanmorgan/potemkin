import type { Patch } from './patches.js';
import { parsePointer } from './patches.js';

// Pure data transformations for the forward-blocks the plugin merges into Specmatic.
// The engine does not execute these; they are consumed by the downstream Kotlin plugin.

export interface WorkflowIdEntry {
  readonly extract: string;
  readonly use: string;
}

export interface WorkflowConfig {
  readonly ids: Record<string, WorkflowIdEntry>;
}

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

// Translate RFC 6902 patches into the `actions[]` shape Specmatic's Overlay consumes:
// each patch becomes { target: <JSONPath>, update | remove: <value> }.
//
// `move`/`copy` are rejected here because the source node's value is not available
// on the engine's translate path, and emitting `update: null` would silently corrupt
// the spec. The Kotlin OverlayApplier resolves `move`/`copy` against the parsed spec.

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
      case 'copy':
        throw new Error(
          `Overlay '${p.op}' cannot be translated without the source spec ` +
            `(from '${p.from}' to '${p.path}'): the source value is not available ` +
            `on this path. Apply move/copy via the spec-aware OverlayApplier instead.`,
        );
      default:
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

// Merge forward-block configs: potemkin scalars override specmatic's, lists
// concatenate after specmatic's entries, objects merge recursively per key.

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
