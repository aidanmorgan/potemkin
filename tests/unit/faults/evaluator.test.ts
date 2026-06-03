/**
 * Unit tests for the fault rule evaluator — focuses on scope-check behaviour.
 */
import { evaluateFaultRules } from '../../../src/faults/evaluator';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import type { FaultRule } from '../../../src/dsl/types';
import type { Command } from '../../../src/types';
import type { Logger } from '../../../src/observability/logger';

const cel = createCelEvaluator();

function makeScopedFaultRule(requiredScopes: string[]): FaultRule {
  return {
    name: 'test-fault',
    match: {
      boundary: '*',
      condition: 'true',
      requiredScopes,
    },
    response: { status: 503, body: { error: 'fault' } },
  };
}

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    commandId: 'cmd-1',
    boundary: 'TestBoundary',
    intent: 'mutation',
    payload: {},
    httpMethod: 'POST',
    path: '/test',
    origin: 'inbound',
    depth: 0,
    ...overrides,
  } as Command;
}

function makeMockLogger() {
  const warnMessages: unknown[] = [];
  const debugMessages: unknown[] = [];
  const logger = {
    warn: (_obj: unknown, msg: unknown) => warnMessages.push(msg),
    debug: (_obj: unknown, msg: unknown) => debugMessages.push(msg),
    info: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    child: function () { return this; },
  } as unknown as Logger;
  return { logger, warnMessages, debugMessages };
}

describe('faults/evaluator — requiredScopes with unauthenticated request', () => {
  const rule = makeScopedFaultRule(['admin']);
  const unauthenticatedCommand = makeCommand({ actor: undefined });

  it('returns null (no match) when the request is unauthenticated and a scope is required', () => {
    const result = evaluateFaultRules({
      command: unauthenticatedCommand,
      boundaryFaults: [rule],
      globalFaults: [],
      dynamicFaults: [],
      cel,
    });
    expect(result).toBeNull();
  });

  it('does not emit a warn-level log for an unauthenticated request against a scoped rule', () => {
    const { logger, warnMessages } = makeMockLogger();
    evaluateFaultRules({
      command: unauthenticatedCommand,
      boundaryFaults: [rule],
      globalFaults: [],
      dynamicFaults: [],
      cel,
      logger,
    });
    expect(warnMessages).toHaveLength(0);
  });

  it('emits a debug-level log confirming the no-match path for an unauthenticated request', () => {
    const { logger, debugMessages } = makeMockLogger();
    evaluateFaultRules({
      command: unauthenticatedCommand,
      boundaryFaults: [rule],
      globalFaults: [],
      dynamicFaults: [],
      cel,
      logger,
    });
    expect(debugMessages.length).toBeGreaterThan(0);
    expect(
      debugMessages.some((m) => typeof m === 'string' && m.includes('no-match')),
    ).toBe(true);
  });

  it('matches the rule when the actor has the required scope', () => {
    const authenticatedCommand = makeCommand({ actor: { id: 'user-1', scopes: ['admin'] } });
    const result = evaluateFaultRules({
      command: authenticatedCommand,
      boundaryFaults: [rule],
      globalFaults: [],
      dynamicFaults: [],
      cel,
    });
    expect(result).not.toBeNull();
    expect(result?.status).toBe(503);
  });
});
