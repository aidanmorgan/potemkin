/**
 * LALR(1) parse-table generator.
 *
 * Strategy: build the canonical LR(1) collection, then merge item sets that
 * share the same LR(0) core (this yields LALR(1) states). ACTION/GOTO tables
 * are filled with shift/reduce/accept entries; shift/reduce and reduce/reduce
 * conflicts are resolved using the operator-precedence declarations from
 * `grammar.ts`. Any conflict the declarations cannot resolve is thrown as an
 * error at generation time, so a checked-in table is always conflict-free.
 *
 * This module is dev/codegen-time machinery: `scripts/gen-cel-tables.ts` runs
 * it and serialises the result to `tables.generated.ts`. The runtime parser
 * never instantiates it.
 */

import {
  PRODUCTIONS, PRECEDENCE, START,
  type Production, type Sym, type Assoc,
} from './grammar.js';

export const EOF = '$end';
const AUG_START = "S'";

/** A shift/goto, reduce, or accept table entry. */
export type Action =
  | { type: 'shift'; state: number }
  | { type: 'reduce'; production: number }
  | { type: 'accept' };

export interface ParseTables {
  /** Number of states. */
  readonly stateCount: number;
  /** ACTION[state][terminal] → Action. */
  readonly action: ReadonlyArray<Readonly<Record<string, Action>>>;
  /** GOTO[state][nonterminal] → state. */
  readonly goto: ReadonlyArray<Readonly<Record<string, number>>>;
  /** Production metadata: lhs + rhs length, indexed by production number. */
  readonly productions: ReadonlyArray<{ lhs: Sym; length: number }>;
}

// ---------------------------------------------------------------------------
// Grammar analysis helpers
// ---------------------------------------------------------------------------

interface AnalyzedGrammar {
  readonly productions: readonly Production[];
  readonly nonterminals: ReadonlySet<Sym>;
  readonly terminals: ReadonlySet<Sym>;
  readonly byLhs: ReadonlyMap<Sym, number[]>;
  /** precedence/assoc by terminal, plus level index (higher = tighter). */
  readonly precOf: ReadonlyMap<Sym, { level: number; assoc: Assoc }>;
}

function analyze(): AnalyzedGrammar {
  // Augmented grammar: prod 0' is S' → Expr (real productions keep their
  // original indices by appending the augmented production at the END and
  // remembering it separately — but the driver expects production indices to
  // match grammar.ts, so we keep the augmented start as a distinct sentinel).
  const productions = PRODUCTIONS;
  const nonterminals = new Set<Sym>([AUG_START]);
  for (const p of productions) nonterminals.add(p.lhs);

  const symbols = new Set<Sym>();
  for (const p of productions) for (const s of p.rhs) symbols.add(s);
  const terminals = new Set<Sym>([EOF]);
  for (const s of symbols) if (!nonterminals.has(s)) terminals.add(s);

  const byLhs = new Map<Sym, number[]>();
  productions.forEach((p, idx) => {
    const arr = byLhs.get(p.lhs) ?? [];
    arr.push(idx);
    byLhs.set(p.lhs, arr);
  });

  const precOf = new Map<Sym, { level: number; assoc: Assoc }>();
  PRECEDENCE.forEach((lvl, i) => {
    for (const t of lvl.terminals) precOf.set(t, { level: i, assoc: lvl.assoc });
  });

  return { productions, nonterminals, terminals, byLhs, precOf };
}

/** Precedence terminal of a production: explicit `%prec`, else rightmost terminal. */
function productionPrec(g: AnalyzedGrammar, prod: Production): Sym | undefined {
  if (prod.prec) return prod.prec;
  for (let k = prod.rhs.length - 1; k >= 0; k--) {
    const s = prod.rhs[k]!;
    if (g.terminals.has(s)) return s;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// FIRST sets
// ---------------------------------------------------------------------------

function computeFirst(g: AnalyzedGrammar, nullable: Set<Sym>): Map<Sym, Set<Sym>> {
  const first = new Map<Sym, Set<Sym>>();
  for (const t of g.terminals) first.set(t, new Set([t]));
  for (const nt of g.nonterminals) first.set(nt, new Set());

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of g.productions) {
      const fl = first.get(p.lhs)!;
      // FIRST of the rhs sequence: add FIRST(s) for each leading symbol, and
      // continue past a symbol only when it is nullable.
      for (const s of p.rhs) {
        const fs = first.get(s)!;
        for (const t of fs) {
          if (!fl.has(t)) { fl.add(t); changed = true; }
        }
        if (!nullable.has(s)) break;
      }
    }
  }
  return first;
}

/** Compute the nullable nonterminal set to a fixpoint. */
function computeNullable(g: AnalyzedGrammar): Set<Sym> {
  const nullable = new Set<Sym>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of g.productions) {
      if (nullable.has(p.lhs)) continue;
      if (p.rhs.every(s => nullable.has(s))) { nullable.add(p.lhs); changed = true; }
    }
  }
  return nullable;
}

/** FIRST of a symbol sequence followed by a single lookahead terminal. */
function firstOfSeq(
  first: Map<Sym, Set<Sym>>,
  nullable: Set<Sym>,
  seq: readonly Sym[],
  lookahead: Sym,
): Set<Sym> {
  const result = new Set<Sym>();
  let allNullable = true;
  for (const s of seq) {
    for (const t of first.get(s)!) result.add(t);
    if (!nullable.has(s)) { allNullable = false; break; }
  }
  if (allNullable) result.add(lookahead);
  return result;
}

// ---------------------------------------------------------------------------
// LR(1) items and closure
// ---------------------------------------------------------------------------

interface LR1Item {
  readonly prod: number;   // production index (-1 = augmented S' → · Expr $)
  readonly dot: number;    // position of the dot in the rhs
  readonly look: Sym;      // lookahead terminal
}

const AUG_PROD: Production = { lhs: AUG_START, rhs: [START] };

function prodOf(prod: number): Production {
  return prod === -1 ? AUG_PROD : PRODUCTIONS[prod]!;
}

function itemKey(it: LR1Item): string { return `${it.prod}:${it.dot}:${it.look}`; }

function closure(
  g: AnalyzedGrammar,
  first: Map<Sym, Set<Sym>>,
  nullable: Set<Sym>,
  items: LR1Item[],
): LR1Item[] {
  const set = new Map<string, LR1Item>();
  const queue: LR1Item[] = [];
  for (const it of items) {
    const k = itemKey(it);
    if (!set.has(k)) { set.set(k, it); queue.push(it); }
  }
  while (queue.length) {
    const it = queue.shift()!;
    const prod = prodOf(it.prod);
    const sym = prod.rhs[it.dot];
    if (sym === undefined || !g.nonterminals.has(sym)) continue;
    const beta = prod.rhs.slice(it.dot + 1);
    const lookaheads = firstOfSeq(first, nullable, beta, it.look);
    for (const pIdx of g.byLhs.get(sym) ?? []) {
      for (const la of lookaheads) {
        const ni: LR1Item = { prod: pIdx, dot: 0, look: la };
        const nk = itemKey(ni);
        if (!set.has(nk)) { set.set(nk, ni); queue.push(ni); }
      }
    }
  }
  return [...set.values()];
}

function gotoSet(
  g: AnalyzedGrammar,
  first: Map<Sym, Set<Sym>>,
  nullable: Set<Sym>,
  items: LR1Item[],
  sym: Sym,
): LR1Item[] {
  const moved: LR1Item[] = [];
  for (const it of items) {
    const prod = prodOf(it.prod);
    if (prod.rhs[it.dot] === sym) {
      moved.push({ prod: it.prod, dot: it.dot + 1, look: it.look });
    }
  }
  return moved.length ? closure(g, first, nullable, moved) : [];
}

/** Canonical-collection state: the LR(1) item set with a stable signature. */
function coreSignature(items: LR1Item[]): string {
  // LR(0) core: prod:dot pairs (ignore lookahead), sorted+deduped.
  const cores = new Set<string>();
  for (const it of items) cores.add(`${it.prod}:${it.dot}`);
  return [...cores].sort().join('|');
}

function fullSignature(items: LR1Item[]): string {
  return [...items].map(itemKey).sort().join('|');
}

// ---------------------------------------------------------------------------
// Table construction
// ---------------------------------------------------------------------------

export function buildTables(): ParseTables {
  const g = analyze();
  const nullable = computeNullable(g);
  const first = computeFirst(g, nullable);

  // 1) Canonical LR(1) collection.
  const start = closure(g, first, nullable, [{ prod: -1, dot: 0, look: EOF }]);
  const states: LR1Item[][] = [start];
  const fullSigToState = new Map<string, number>([[fullSignature(start), 0]]);
  // transitions[state][sym] = nextState
  const transitions: Array<Map<Sym, number>> = [new Map()];

  for (let s = 0; s < states.length; s++) {
    const items = states[s]!;
    // Symbols appearing immediately after a dot.
    const nextSyms = new Set<Sym>();
    for (const it of items) {
      const sym = prodOf(it.prod).rhs[it.dot];
      if (sym !== undefined) nextSyms.add(sym);
    }
    for (const sym of nextSyms) {
      const target = gotoSet(g, first, nullable, items, sym);
      if (target.length === 0) continue;
      const sig = fullSignature(target);
      let ts = fullSigToState.get(sig);
      if (ts === undefined) {
        ts = states.length;
        states.push(target);
        transitions.push(new Map());
        fullSigToState.set(sig, ts);
      }
      transitions[s]!.set(sym, ts);
    }
  }

  // 2) Merge LR(1) states sharing the same LR(0) core → LALR(1).
  const coreToMerged = new Map<string, number>();
  const oldToMerged: number[] = new Array(states.length);
  const mergedItems: LR1Item[][] = [];
  for (let s = 0; s < states.length; s++) {
    const core = coreSignature(states[s]!);
    let m = coreToMerged.get(core);
    if (m === undefined) {
      m = mergedItems.length;
      coreToMerged.set(core, m);
      mergedItems.push([...states[s]!]);
    } else {
      mergedItems[m]!.push(...states[s]!);
    }
    oldToMerged[s] = m;
  }
  // Dedup merged item sets (same prod:dot:look may arrive from both halves).
  const mergedDedup: LR1Item[][] = mergedItems.map(items => {
    const map = new Map<string, LR1Item>();
    for (const it of items) map.set(itemKey(it), it);
    return [...map.values()];
  });

  // Merged transitions.
  const mTrans: Array<Map<Sym, number>> = mergedDedup.map(() => new Map());
  for (let s = 0; s < states.length; s++) {
    const from = oldToMerged[s]!;
    for (const [sym, to] of transitions[s]!) {
      mTrans[from]!.set(sym, oldToMerged[to]!);
    }
  }

  // 3) Build ACTION/GOTO with precedence-based conflict resolution.
  const action: Array<Record<string, Action>> = mergedDedup.map(() => ({}));
  const gotoTbl: Array<Record<string, number>> = mergedDedup.map(() => ({}));

  for (let s = 0; s < mergedDedup.length; s++) {
    // GOTO + shifts from transitions.
    for (const [sym, to] of mTrans[s]!) {
      if (g.nonterminals.has(sym)) {
        gotoTbl[s]![sym] = to;
      } else {
        setAction(g, action[s]!, sym, { type: 'shift', state: to }, s);
      }
    }
    // Reduces / accept from items with the dot at the end.
    for (const it of mergedDedup[s]!) {
      const prod = prodOf(it.prod);
      if (it.dot !== prod.rhs.length) continue;
      if (it.prod === -1) {
        // S' → Expr ·  on $end ⇒ accept
        if (it.look === EOF) setAction(g, action[s]!, EOF, { type: 'accept' }, s);
        continue;
      }
      setAction(g, action[s]!, it.look, { type: 'reduce', production: it.prod }, s);
    }
  }

  return {
    stateCount: mergedDedup.length,
    action,
    goto: gotoTbl,
    productions: PRODUCTIONS.map(p => ({ lhs: p.lhs, length: p.rhs.length })),
  };

  // --- conflict-aware action setter (closure over g) ---
  function setAction(
    gram: AnalyzedGrammar,
    row: Record<string, Action>,
    term: Sym,
    next: Action,
    stateIdx: number,
  ): void {
    const existing = row[term];
    if (!existing) { row[term] = next; return; }
    if (existing.type === next.type) {
      if (existing.type === 'shift' && next.type === 'shift' && existing.state === next.state) return;
      if (existing.type === 'reduce' && next.type === 'reduce' && existing.production === next.production) return;
      if (existing.type === 'accept') return;
    }
    const resolved = resolveConflict(gram, existing, next, term, stateIdx);
    row[term] = resolved;
  }
}

/** Resolve a shift/reduce or reduce/reduce conflict using precedence. */
function resolveConflict(
  g: AnalyzedGrammar,
  a: Action,
  b: Action,
  term: Sym,
  stateIdx: number,
): Action {
  const shift = a.type === 'shift' ? a : b.type === 'shift' ? b : undefined;
  const reduce = a.type === 'reduce' ? a : b.type === 'reduce' ? b : undefined;

  // shift/reduce
  if (shift && reduce) {
    const termPrec = g.precOf.get(term);
    const prodPrecTerm = productionPrec(g, PRODUCTIONS[reduce.production]!);
    const prodPrec = prodPrecTerm ? g.precOf.get(prodPrecTerm) : undefined;
    if (termPrec && prodPrec) {
      if (prodPrec.level > termPrec.level) return reduce;       // reduce binds tighter
      if (prodPrec.level < termPrec.level) return shift;        // shift binds tighter
      // equal precedence → use associativity of the level
      if (prodPrec.assoc === 'left') return reduce;
      if (prodPrec.assoc === 'right') return shift;
      // nonassoc → error; but we have none in this grammar
    }
    throw new Error(
      `LALR conflict: unresolved shift/reduce on '${term}' in state ${stateIdx} ` +
      `(reduce by production ${reduce.production} ${PRODUCTIONS[reduce.production]!.lhs})`,
    );
  }

  // reduce/reduce — prefer the earlier production (yacc convention) only when
  // it is safe; otherwise it is a genuine grammar ambiguity → throw.
  if (a.type === 'reduce' && b.type === 'reduce') {
    throw new Error(
      `LALR conflict: reduce/reduce on '${term}' in state ${stateIdx} ` +
      `(productions ${a.production} and ${b.production})`,
    );
  }

  throw new Error(`LALR conflict: incompatible actions on '${term}' in state ${stateIdx}`);
}
