/**
 * Unit tests for the LALR(1) table generator. These exercise the generator
 * (lalr.ts) and the grammar data (grammar.ts), and assert the generated tables
 * are conflict-free and structurally sound. They also guard against drift
 * between the grammar and the committed tables.
 */
import { buildTables, EOF } from '../../../../src/cel/grammar/lalr';
import { TABLES } from '../../../../src/cel/grammar/tables.generated';
import { PRODUCTIONS } from '../../../../src/cel/grammar/grammar';

describe('cel/grammar/lalr table generator', () => {
  const tables = buildTables();

  it('produces a conflict-free table (build does not throw)', () => {
    expect(() => buildTables()).not.toThrow();
  });

  it('has at least one accept action on end-of-input', () => {
    const accepts = tables.action.filter(row => row[EOF]?.type === 'accept');
    expect(accepts.length).toBeGreaterThanOrEqual(1);
  });

  it('every reduce action references a real production', () => {
    for (const row of tables.action) {
      for (const act of Object.values(row)) {
        if (act.type === 'reduce') {
          expect(act.production).toBeGreaterThanOrEqual(0);
          expect(act.production).toBeLessThan(PRODUCTIONS.length);
        }
      }
    }
  });

  it('every shift/goto target is a valid state index', () => {
    for (const row of tables.action) {
      for (const act of Object.values(row)) {
        if (act.type === 'shift') {
          expect(act.state).toBeGreaterThanOrEqual(0);
          expect(act.state).toBeLessThan(tables.stateCount);
        }
      }
    }
    for (const row of tables.goto) {
      for (const target of Object.values(row)) {
        expect(target).toBeGreaterThanOrEqual(0);
        expect(target).toBeLessThan(tables.stateCount);
      }
    }
  });

  it('production metadata matches the grammar', () => {
    expect(tables.productions).toHaveLength(PRODUCTIONS.length);
    tables.productions.forEach((p, i) => {
      expect(p.lhs).toBe(PRODUCTIONS[i]!.lhs);
      expect(p.length).toBe(PRODUCTIONS[i]!.rhs.length);
    });
  });

  it('the committed tables match a fresh generation (no drift)', () => {
    // If this fails, regenerate: npx tsx scripts/gen-cel-tables.ts
    expect(TABLES.stateCount).toBe(tables.stateCount);
    expect(TABLES.action).toEqual(tables.action);
    expect(TABLES.goto).toEqual(tables.goto);
    expect(TABLES.productions).toEqual(tables.productions);
  });
});
