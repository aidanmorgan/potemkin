import { isRecord, type Patch } from '../contracts/value.js';
import { parsePointer } from '../model/patches.js';

// Pure data transformations for the forward-blocks the plugin merges into Specmatic.

export interface WorkflowIdEntry {
  readonly extract: string;
  readonly use: string;
}

export interface WorkflowConfig {
  readonly ids: Record<string, WorkflowIdEntry>;
}

export function validateWorkflowForward(raw: unknown): WorkflowConfig {
  if (!isRecord(raw)) {
    throw new Error('workflow: must be an object');
  }
  const ids = raw['ids'];
  if (!isRecord(ids)) {
    throw new Error('workflow.ids: must be an object');
  }
  const out: Record<string, WorkflowIdEntry> = {};
  for (const [k, v] of Object.entries(ids)) {
    if (!isRecord(v)) {
      throw new Error(`workflow.ids.${k}: must be { extract, use }`);
    }
    const extract = v['extract'];
    const use = v['use'];
    if (typeof extract !== 'string') {
      throw new Error(`workflow.ids.${k}.extract: must be a JSONPath string`);
    }
    if (typeof use !== 'string') {
      throw new Error(`workflow.ids.${k}.use: must be a JSONPath string`);
    }
    out[k] = { extract, use };
  }
  return { ids: out };
}

export interface GovernanceConfig {
  readonly report?: {
    readonly format?: string;
    readonly successCriteria?: {
      readonly minCoverage?: number;
      readonly excludedEndpoints?: readonly string[];
    };
  };
  readonly successCriterion?: string;
}

export function validateGovernanceForward(raw: unknown): GovernanceConfig {
  if (!isRecord(raw)) {
    throw new Error('governance: must be an object');
  }
  const obj = raw;
  const out: { -readonly [K in keyof GovernanceConfig]: GovernanceConfig[K] } = {};
  if (obj['report'] !== undefined) {
    if (!isRecord(obj['report'])) {
      throw new Error('governance.report: must be an object');
    }
    const report = obj['report'];
    if (report['format'] !== undefined && typeof report['format'] !== 'string') {
      throw new Error('governance.report.format: must be a string');
    }
    if (report['successCriteria'] !== undefined) {
      const criteria = report['successCriteria'];
      if (!isRecord(criteria)) {
        throw new Error('governance.report.successCriteria: must be an object');
      }
      const values = criteria;
      if (
        values['minCoverage'] !== undefined &&
        (typeof values['minCoverage'] !== 'number' || !Number.isFinite(values['minCoverage']))
      ) {
        throw new Error('governance.report.successCriteria.minCoverage: must be a finite number');
      }
      if (
        values['excludedEndpoints'] !== undefined &&
        (!Array.isArray(values['excludedEndpoints']) ||
          values['excludedEndpoints'].some((value) => typeof value !== 'string'))
      ) {
        throw new Error(
          'governance.report.successCriteria.excludedEndpoints: must be an array of strings',
        );
      }
    }
    const successCriteria = report['successCriteria'];
    out.report = {
      ...(typeof report['format'] === 'string' ? { format: report['format'] } : {}),
      ...(isRecord(successCriteria)
        ? {
            successCriteria: {
              ...(typeof successCriteria['minCoverage'] === 'number'
                ? { minCoverage: successCriteria['minCoverage'] }
                : {}),
              ...(Array.isArray(successCriteria['excludedEndpoints'])
                ? {
                    excludedEndpoints: successCriteria['excludedEndpoints'].filter(
                      (value): value is string => typeof value === 'string',
                    ),
                  }
                : {}),
            },
          }
        : {}),
    };
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
// `move`/`copy` are rejected here because the source value is unavailable on this
// path; the Kotlin OverlayApplier resolves them against the parsed spec.

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

// Merge forward-block configs: scalars override, lists concatenate, objects merge recursively.

export function mergeForwardBlock(
  specmatic: Readonly<Record<string, unknown>> | undefined,
  potemkin: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (specmatic === undefined && potemkin === undefined) return {};
  if (specmatic === undefined) return { ...potemkin };
  if (potemkin === undefined) return { ...specmatic };
  const result: Record<string, unknown> = { ...specmatic };
  for (const [k, v] of Object.entries(potemkin)) {
    const existing = result[k];
    if (Array.isArray(existing) && Array.isArray(v)) {
      result[k] = [...existing, ...v];
    } else if (isRecord(existing) && isRecord(v)) {
      result[k] = mergeForwardBlock(existing, v);
    } else if (v !== undefined) {
      result[k] = v;
    }
  }
  return result;
}
