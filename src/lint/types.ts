import type { OpenApiDoc } from '../contract/loader.js';
import type { RuntimeProgram } from '../model/runtime.js';
import type { TransitionModel } from '../model/transitionModel.js';
import type { JsonValue } from '../contracts/value.js';

/** The source-neutral input shared by every static model check. */
export interface LintContext {
  readonly program: Pick<RuntimeProgram, 'boundaries' | 'policies'>;
  readonly openapi: OpenApiDoc;
  readonly transitionModel?: TransitionModel;
  readonly sourceByBoundary?: Readonly<Record<string, string>>;
}

export interface LintLocation {
  readonly file?: string;
  readonly boundary?: string;
  readonly pointer?: string;
}

export interface LintFinding {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly location: LintLocation;
  readonly details?: JsonValue;
}

export type LintCheck = (context: LintContext) => readonly LintFinding[];
