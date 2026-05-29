import type { Command, JsonObject } from '../types.js';
import type { FaultRule, FaultResponse } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import { CelPhase } from '../cel/phases.js';
import { checkScopes } from '../identity/scopeChecker.js';

export interface FaultEvalInput {
  readonly command: Command;
  readonly boundaryFaults: readonly FaultRule[];
  readonly globalFaults: readonly FaultRule[];
  readonly dynamicFaults: readonly FaultRule[];
  readonly cel: CelEvaluator;
  readonly state?: JsonObject | null;
  readonly logger?: Logger;
}

export function evaluateFaultRules(input: FaultEvalInput): FaultResponse | null {
  const { command, boundaryFaults, globalFaults, dynamicFaults, cel, state, logger } = input;

  // Priority: dynamic > boundary > global
  const tiers: readonly (readonly FaultRule[])[] = [dynamicFaults, boundaryFaults, globalFaults];

  for (const rules of tiers) {
    for (const rule of rules) {
      const matched = matchesFaultRule(rule, command, cel, state, logger);
      if (matched) {
        logger?.info({ faultName: rule.name, status: rule.response.status }, 'DSL fault rule matched');
        return rule.response;
      }
    }
  }

  return null;
}

function matchesFaultRule(
  rule: FaultRule,
  command: Command,
  cel: CelEvaluator,
  state: JsonObject | null | undefined,
  logger: Logger | undefined,
): boolean {
  // 1. Boundary filter (for global rules)
  if (rule.match.boundary !== undefined && rule.match.boundary !== '*') {
    if (rule.match.boundary !== command.boundary) return false;
  }

  // 2. Intent filter
  if (rule.match.intent !== undefined && rule.match.intent !== command.intent) return false;

  // 2b. Header matching: all specified headers must be present on the command.
  // For value "*", only presence is required; otherwise exact value match.
  if (rule.match.headers && Object.keys(rule.match.headers).length > 0) {
    const reqHeaders = command.headers ?? {};
    for (const [name, expected] of Object.entries(rule.match.headers)) {
      const actual = reqHeaders[name];
      if (actual === undefined) return false;
      if (expected !== '*' && actual !== expected) return false;
    }
  }

  // 3. RBAC scope check
  if (rule.match.requiredScopes && rule.match.requiredScopes.length > 0) {
    try {
      checkScopes(command.actor, rule.match.requiredScopes as string[], rule.name);
    } catch {
      return false;
    }
  }

  // 4. Requires guards
  if (rule.match.requires && rule.match.requires.length > 0) {
    const celCtx: Record<string, unknown> = {
      command: command as unknown as Record<string, unknown>,
      payload: command.payload,
      state: state ?? {},
    };
    for (const req of rule.match.requires) {
      try {
        const result = cel.evaluateDslValue(req.condition, celCtx, CelPhase.Behavior);
        if (result !== true) return false;
      } catch {
        return false;
      }
    }
  }

  // 5. Main condition
  const celCtx: Record<string, unknown> = {
    command: command as unknown as Record<string, unknown>,
    payload: command.payload,
    state: state ?? {},
  };
  try {
    const result = cel.evaluateDslValue(rule.match.condition, celCtx, CelPhase.Behavior);
    if (result !== true) return false;
  } catch (err) {
    logger?.debug({ faultName: rule.name, err }, 'Fault rule condition evaluation error — treating as no-match');
    return false;
  }

  // 6. Probability gate
  if (rule.match.probability !== undefined) {
    if (Math.random() >= rule.match.probability) return false;
  }

  return true;
}
