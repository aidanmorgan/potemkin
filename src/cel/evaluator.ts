import { CelPhase } from './phases.js';

export interface CompiledCel {
  readonly source: string;
}

export interface CelContext {
  readonly [k: string]: unknown;
}

export interface CelEvaluator {
  compile(expression: string): CompiledCel;
  evaluate(
    expression: string | CompiledCel,
    ctx: CelContext,
    phase: CelPhase,
  ): unknown;
}

export function createCelEvaluator(): CelEvaluator {
  throw new Error('NotImplemented: cel/evaluator.createCelEvaluator');
}
