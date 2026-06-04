/**
 * Strict boot-time linting of the fully-composed simulation.
 *
 * Each check inspects the composed CompiledDsl + OpenAPI and returns located
 * findings. The engine refuses to boot if any ERROR finding is present, printing
 * a grouped, located report; WARNING findings are printed but do not block.
 */
import type { CompiledDsl } from '../dsl/types.js';
import type { OpenApiDoc } from '../contract/loader.js';

export type LintSeverity = 'error' | 'warning';

/** Where a finding is located, as precisely as the check can determine. */
export interface LintLocation {
  /** Source file (DSL module / resource file) when known. */
  readonly file?: string;
  /** Boundary name the finding pertains to. */
  readonly boundary?: string;
  /** A path/pointer within the boundary (e.g. "reducers[0].on", "behaviors[1].emit"). */
  readonly pointer?: string;
}

export interface LintFinding {
  readonly severity: LintSeverity;
  /** Stable machine code, e.g. REFERENTIAL_INTEGRITY, CEL_REFERENCE. */
  readonly code: string;
  readonly message: string;
  readonly location: LintLocation;
}

/** Everything a check needs to inspect the composed model. */
export interface LintContext {
  readonly dsl: CompiledDsl;
  readonly openapi: OpenApiDoc;
  /** boundary name -> source file path, when the loader recorded it. */
  readonly boundarySourcePaths?: Record<string, string>;
}

/** A single lint check over the composed model. Pure: returns findings, never throws. */
export type LintCheck = (ctx: LintContext) => readonly LintFinding[];

// ── Finding constructors (keep call sites terse) ──────────────────────────────

export function lintError(code: string, message: string, location: LintLocation = {}): LintFinding {
  return { severity: 'error', code, message, location };
}

export function lintWarning(code: string, message: string, location: LintLocation = {}): LintFinding {
  return { severity: 'warning', code, message, location };
}
