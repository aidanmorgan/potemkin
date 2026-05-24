/**
 * regex-and-matchers.integration.test.ts
 *
 * End-to-end integration tests for CEL string.matches() — regex patterns,
 * anchors, alternation, and special characters — wired through the real DSL.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import { CelPhase } from '../../../src/cel/phases.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import { runCelFixture } from './_helpers/dsl-builder.js';

const cel = createCelEvaluator();
const ev = (expr: string, ctx: Record<string, unknown> = {}) =>
  cel.evaluate(expr, ctx, CelPhase.Behavior);

// ── Direct evaluator — pattern variations ─────────────────────────────────────

describe('regex: email-like pattern', () => {
  it('valid email-like string matches', () => {
    expect(ev('"test@example.com".matches("[a-z]+@[a-z]+\\\\.[a-z]+")')).toBe(true);
  });

  it('string without @ does not match email pattern', () => {
    expect(ev('"notanemail".matches("[a-z]+@[a-z]+\\\\.[a-z]+")')).toBe(false);
  });
});

describe('regex: UUID-like pattern', () => {
  it('valid UUID matches', () => {
    const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    expect(
      ev(`"550e8400-e29b-41d4-a716-446655440000".matches("${uuidPattern}")`),
    ).toBe(true);
  });

  it('non-UUID string does not match', () => {
    const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    expect(ev(`"not-a-uuid".matches("${uuidPattern}")`)).toBe(false);
  });
});

describe('regex: anchors (^ and $)', () => {
  it('^LOAN- pattern matches at start of string', () => {
    expect(ev('"LOAN-12345".matches("^LOAN-")')).toBe(true);
  });

  it('^LOAN- pattern rejects string with prefix before LOAN-', () => {
    expect(ev('"PREFIX-LOAN-12345".matches("^LOAN-")')).toBe(false);
  });

  it('[0-9]+$ pattern matches string ending with digits', () => {
    expect(ev('"LOAN-99".matches("[0-9]+$")')).toBe(true);
  });

  it('^LOAN-[0-9]+$ full-anchored match', () => {
    expect(ev('"LOAN-12345".matches("^LOAN-[0-9]+$")')).toBe(true);
    expect(ev('"LOAN-12345-extra".matches("^LOAN-[0-9]+$")')).toBe(false);
  });
});

describe('regex: alternation patterns', () => {
  it('alternation matches first option', () => {
    expect(ev('"ACTIVE".matches("ACTIVE|DRAFT|SETTLED")')).toBe(true);
  });

  it('alternation matches middle option', () => {
    expect(ev('"DRAFT".matches("ACTIVE|DRAFT|SETTLED")')).toBe(true);
  });

  it('alternation matches last option', () => {
    expect(ev('"SETTLED".matches("ACTIVE|DRAFT|SETTLED")')).toBe(true);
  });

  it('alternation does not match unknown value', () => {
    expect(ev('"UNKNOWN".matches("ACTIVE|DRAFT|SETTLED")')).toBe(false);
  });
});

describe('regex: special characters in pattern', () => {
  it('dot in pattern matches any character (unescaped)', () => {
    // Dot without escape matches any single char
    expect(ev('"LOAN.12345".matches("LOAN.12345")')).toBe(true);
    expect(ev('"LOANX12345".matches("LOAN.12345")')).toBe(true);
  });

  it('literal dot escaped as \\\\. matches only literal dot', () => {
    expect(ev('"LOAN.12345".matches("LOAN\\\\.12345")')).toBe(true);
    expect(ev('"LOANX12345".matches("LOAN\\\\.12345")')).toBe(false);
  });

  it('pattern with + quantifier', () => {
    expect(ev('"aaa".matches("a+")')).toBe(true);
    expect(ev('"bbb".matches("a+")')).toBe(false);
  });

  it('pattern with ? quantifier (optional character)', () => {
    expect(ev('"colour".matches("colo(u)?r")')).toBe(true);
    expect(ev('"color".matches("colo(u)?r")')).toBe(true);
  });
});

describe('regex: context variables in pattern match', () => {
  it('matches pattern from context variable', () => {
    expect(ev('val.matches(pattern)', { val: 'LOAN-999', pattern: '^LOAN-[0-9]+$' })).toBe(true);
    expect(ev('val.matches(pattern)', { val: 'GRANT-999', pattern: '^LOAN-[0-9]+$' })).toBe(false);
  });
});

describe('regex: edge cases', () => {
  it('empty string matches empty pattern', () => {
    expect(ev('"".matches("")')).toBe(true);
  });

  it('empty string does not match non-empty required pattern', () => {
    expect(ev('"".matches("[a-z]+")')).toBe(false);
  });

  it('matches is case-sensitive by default', () => {
    expect(ev('"HELLO".matches("hello")')).toBe(false);
    expect(ev('"hello".matches("hello")')).toBe(true);
  });
});

// ── Documenting capturing group behaviour ────────────────────────────────────
// CEL matches() returns a boolean, not capture groups.
// The function only checks whether the pattern matches anywhere in the string.

describe('regex: capturing groups — documented behaviour', () => {
  it('matches() returns bool even with capture groups in pattern', () => {
    // Capturing groups are syntactically valid but return only bool
    const result = ev('"hello world".matches("(hello) (world)")');
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
  });

  it('capture group syntax with alternation still returns bool', () => {
    const result = ev('"LOAN-123".matches("(LOAN|GRANT)-([0-9]+)")');
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
  });
});

// ── End-to-end DSL integration tests ─────────────────────────────────────────

describe('regex: DSL behavior condition — reject non-LOAN- prefixed IDs', () => {
  it('behavior fires when entity label starts with LOAN-', async () => {
    const { result, events } = await runCelFixture({
      expression: 'state.label.matches("^LOAN-[0-9]+$")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        label: 'LOAN-99001',
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('behavior blocked when label does NOT match LOAN- pattern (→ 422)', async () => {
    const { result } = await runCelFixture({
      expression: 'state.label.matches("^LOAN-[0-9]+$")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        label: 'GRANT-99001',
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });

  it('behavior blocked for completely non-numeric loan-like ID (e.g. "LOAN-ABC")', async () => {
    const { result } = await runCelFixture({
      expression: 'state.label.matches("^LOAN-[0-9]+$")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        label: 'LOAN-ABC',
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('regex: DSL behavior condition — email-like validation', () => {
  it('behavior fires when status matches valid status pattern', async () => {
    const { result } = await runCelFixture({
      expression: 'state.status.matches("^(ACTIVE|DRAFT|SETTLED)$")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        label: 'test',
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(200);
  });

  it('behavior blocked when status is not one of the allowed values', async () => {
    const { result } = await runCelFixture({
      expression: 'state.status.matches("^(ACTIVE|DRAFT|SETTLED)$")',
      phase: 'condition',
      initialEntity: {
        id: nextUuidv7(),
        label: 'test',
        status: 'PENDING',
      },
      commandPayload: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('regex: DSL reducer assign — boolean from matches() stored as computed', () => {
  it('reducer stores true when label matches pattern', async () => {
    const { state } = await runCelFixture({
      expression: 'state.label.matches("^LOAN-[0-9]+$") ? "valid" : "invalid"',
      phase: 'reducer',
      initialEntity: {
        id: nextUuidv7(),
        label: 'LOAN-500',
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(state!['computed']).toBe('valid');
  });

  it('reducer stores false when label does not match pattern', async () => {
    const { state } = await runCelFixture({
      expression: 'state.label.matches("^LOAN-[0-9]+$") ? "valid" : "invalid"',
      phase: 'reducer',
      initialEntity: {
        id: nextUuidv7(),
        label: 'GRANT-500',
        status: 'ACTIVE',
      },
      commandPayload: {},
    });
    expect(state!['computed']).toBe('invalid');
  });
});
