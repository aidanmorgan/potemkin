/**
 * RED TEAM: CEL injection / host-object access / phase escape / ReDoS.
 *
 * The CEL evaluator binds request-derived context objects (command, event,
 * payload, state). We probe whether a crafted expression or an attacker-shaped
 * payload can:
 *   1. reach host objects via member access (command.constructor, event.__proto__)
 *   2. smuggle non-deterministic builtins ($uuidv7/$now) into the Reducer phase
 *   3. trip ReDoS through matches() with a polynomial pattern the shape guard misses
 */
import { createCelEvaluator } from '../../src/cel/evaluator.js';
import { CelPhase } from '../../src/cel/phases.js';

const cel = createCelEvaluator();

describe('CEL host-object access', () => {
  test('HOST 1: command.constructor leaks the Object fn as a value but is a dead end (not weaponizable)', () => {
    const ctx = { command: { payload: { x: 1 } } };
    let result: unknown;
    try {
      result = cel.evaluate('command.constructor', ctx, CelPhase.Behavior);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[HOST 1] threw:', (e as Error).message);
    }
    // eslint-disable-next-line no-console
    console.log('[HOST 1] command.constructor type=', typeof result);
    // NOTE: this DOES return the host Object function (info smell). The security
    // property that matters is that it can't be chained further: member access
    // on a function throws, and CEL has no call syntax to invoke it. Verified in
    // cel-host-probe.redteam.test.ts. Here we just document the leak-as-value.
    let chained = false;
    try {
      cel.evaluate('command.constructor.constructor', ctx, CelPhase.Behavior);
      chained = true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[HOST 1] chaining blocked:', (e as Error).message);
    }
    expect(chained).toBe(false); // cannot walk past the function — no host escape
  });

  test('HOST 2: event.__proto__.constructor.constructor chain must NOT reach Function', () => {
    const ctx = { event: { payload: {} } };
    let result: unknown;
    try {
      result = cel.evaluate('event.__proto__', ctx, CelPhase.Behavior);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[HOST 2] event.__proto__ threw:', (e as Error).message);
    }
    // eslint-disable-next-line no-console
    console.log('[HOST 2] event.__proto__ =', result, 'type=', typeof result);
    expect(typeof result === 'function').toBe(false);
  });

  test('HOST 3: cannot invoke a method that escapes to host (e.g. constructor())', () => {
    const ctx = { command: {} };
    let escaped = false;
    try {
      // Attempt: command.constructor.constructor("return process")()
      cel.evaluate('command.constructor.constructor("return process")()', ctx, CelPhase.Behavior);
      escaped = true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[HOST 3] blocked with:', (e as Error).message);
    }
    expect(escaped).toBe(false);
  });
});

describe('CEL reducer-phase determinism escape', () => {
  test('PHASE 1: $uuidv7() is banned in Reducer phase', () => {
    let threw = false;
    try {
      cel.evaluate('$uuidv7()', {}, CelPhase.Reducer);
    } catch (e) {
      threw = true;
      // eslint-disable-next-line no-console
      console.log('[PHASE 1] $uuidv7 in reducer:', (e as Error).message);
    }
    expect(threw).toBe(true);
  });

  test('PHASE 2: $now() is banned in Reducer phase', () => {
    let threw = false;
    try {
      cel.evaluate('$now()', {}, CelPhase.Reducer);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('PHASE 3: a payload STRING that looks like ${$uuidv7()} is NOT re-evaluated as CEL', () => {
    // Smuggling attempt: attacker puts a CEL-looking string in the payload, hoping
    // the reducer re-evaluates it (second-order injection). The reducer reads
    // event.payload.title as a plain value — it must stay literal.
    const ctx = { event: { payload: { title: '${$uuidv7()}' } } };
    const result = cel.evaluate('event.payload.title', ctx, CelPhase.Reducer);
    // eslint-disable-next-line no-console
    console.log('[PHASE 3] reducer read of attacker payload string =', result);
    expect(result).toBe('${$uuidv7()}'); // stays literal — no nested evaluation
  });
});

describe('CEL matches() ReDoS', () => {
  test('REDOS 1: nested-quantifier pattern is rejected by the shape guard', () => {
    let threw = false;
    try {
      cel.evaluate('"aaaaaaaaaaaaaaaaaaaa!".matches("(a+)+$")', {}, CelPhase.Behavior);
    } catch (e) {
      threw = true;
      // eslint-disable-next-line no-console
      console.log('[REDOS 1] rejected:', (e as Error).message);
    }
    expect(threw).toBe(true);
  });

  // ReDoS via sequential unbounded quantifiers is demonstrated fast and
  // conclusively in cel-host-probe.redteam.test.ts (GUARD-MISS + SUPER-LINEAR).
  // The full 20x worst-case hangs ~2.8 minutes, so it is NOT run here to keep CI fast.
});
