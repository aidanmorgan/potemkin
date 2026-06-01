import type { Command, JsonObject } from '../types.js';
import type { FaultRule, FaultResponse } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import { CelPhase } from '../cel/phases.js';
import { checkScopes } from '../identity/scopeChecker.js';
import { matchHeadersAnd } from '../engine/headerMatch.js';

export interface FaultEvalInput {
  readonly command: Command;
  readonly boundaryFaults: readonly FaultRule[];
  readonly globalFaults: readonly FaultRule[];
  readonly dynamicFaults: readonly FaultRule[];
  readonly cel: CelEvaluator;
  readonly state?: JsonObject | null;
  readonly logger?: Logger;
}

/**
 * Resolved fault response: the rule's canned response plus the effective
 * pre-response delay in milliseconds. `delay_ms` may be authored either at the
 * top level of the rule (the FaultRule type) or nested under `response` (the
 * dynamic-fault admin payload, which is stored raw and never passes through the
 * DSL parser that normalises the two). Callers apply the delay before responding.
 */
export type ResolvedFaultResponse = FaultResponse & { readonly delay_ms?: number };

export function evaluateFaultRules(input: FaultEvalInput): ResolvedFaultResponse | null {
  const { command, boundaryFaults, globalFaults, dynamicFaults, cel, state, logger } = input;

  // Priority: dynamic > boundary > global
  const tiers: readonly (readonly FaultRule[])[] = [dynamicFaults, boundaryFaults, globalFaults];

  for (const rules of tiers) {
    for (const rule of rules) {
      const matched = matchesFaultRule(rule, command, cel, state, logger);
      if (matched) {
        logger?.info({ faultName: rule.name, status: rule.response.status }, 'DSL fault rule matched');
        const delayMs = resolveFaultDelayMs(rule);
        return delayMs !== undefined
          ? { ...rule.response, delay_ms: delayMs }
          : rule.response;
      }
    }
  }

  return null;
}

/**
 * Resolve a rule's effective pre-response delay. Prefer the normalised top-level
 * `delay_ms` (DSL-parsed rules); fall back to a `delay_ms` nested under `response`
 * (dynamic admin rules stored verbatim).
 */
function resolveFaultDelayMs(rule: FaultRule): number | undefined {
  if (typeof rule.delay_ms === 'number') return rule.delay_ms;
  const nested = (rule.response as { delay_ms?: unknown }).delay_ms;
  return typeof nested === 'number' ? nested : undefined;
}

function matchesFaultRule(
  rule: FaultRule,
  command: Command,
  cel: CelEvaluator,
  state: JsonObject | null | undefined,
  logger: Logger | undefined,
): boolean {
  if (rule.match.boundary !== undefined && rule.match.boundary !== '*') {
    if (rule.match.boundary !== command.boundary) return false;
  }

  if (rule.match.intent !== undefined && rule.match.intent !== command.intent) return false;

  // Header matching: all declared headers must match (AND semantics).
  // Name lookup is case-insensitive; '*' and 'present' are any-value sentinels.
  if (rule.match.headers && Object.keys(rule.match.headers).length > 0) {
    if (!matchHeadersAnd(rule.match.headers, command.headers ?? {})) return false;
  }

  if (rule.match.requiredScopes && rule.match.requiredScopes.length > 0) {
    try {
      checkScopes(command.actor, rule.match.requiredScopes as string[], rule.name);
    } catch (err) {
      logger?.warn(
        { faultName: rule.name, requiredScopes: rule.match.requiredScopes, err },
        'Fault rule scope check failed — treating as no-match',
      );
      return false;
    }
  }

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
      } catch (err) {
        logger?.warn(
          { faultName: rule.name, expr: req.condition, err },
          'Fault rule requires-guard evaluation failed — treating as no-match',
        );
        return false;
      }
    }
  }

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

  if (rule.match.probability !== undefined) {
    if (Math.random() >= rule.match.probability) return false;
  }

  return true;
}
