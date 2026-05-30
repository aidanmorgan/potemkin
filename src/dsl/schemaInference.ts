// Boundary state schema is derived from event templates + reducer patches.
// Declared computed/internal fields merge in. The fixed-point loop iterates
// until types stabilise or the cap (4) trips. Reducer patches cannot write
// to a declared computed-field path (or any prefix-extension of one).

import { BootError } from '../errors.js';
import type { Patch } from './patches.js';
import { parsePointer } from './patches.js';
import type { BoundaryConfig } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FieldKind =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'null'
  | 'array'
  | 'object'
  | 'unknown';

export type Confidence = 'known' | 'narrowed' | 'unknown';

export interface FieldType {
  readonly kind: FieldKind;
  readonly confidence: Confidence;
  /** For array: element type. */
  readonly element?: FieldType;
  /** For object: per-field types. */
  readonly fields?: Record<string, FieldType>;
}

export interface InferredField {
  readonly type: FieldType;
  /** Source descriptors for diagnostics (event name, reducer ref, declared, etc.). */
  readonly sources: readonly string[];
}

/** Map keyed by JSON-Pointer of all known state paths. */
export type InferredSchema = ReadonlyMap<string, InferredField>;

export interface DeclaredComputedField {
  readonly name: string;
  readonly formula: string;
  readonly dependsOn: readonly string[];
}

export interface DeclaredInternalField {
  readonly name: string;
  readonly type: FieldType;
}

export interface DeclaredState {
  readonly computed?: readonly DeclaredComputedField[];
  readonly internal?: readonly DeclaredInternalField[];
}

export interface EventDecl {
  readonly name: string;
  /** Inline CEL-templated object. Either this OR `patches` may be provided. */
  readonly template?: Record<string, string>;
  /** Patch[] against {} for derived/conditional payloads. */
  readonly patches?: readonly Patch[];
}

export interface ReducerDecl {
  /** Event name (bare; cross-boundary handled by the caller). */
  readonly on: string;
  readonly patches?: readonly Patch[];
  /** Marker — implementation lives in a TS file (no `patches:`). */
  readonly implementation?: 'typescript';
}

export interface BoundaryInferenceInput {
  readonly boundary: string;
  readonly events: readonly EventDecl[];
  readonly reducers: readonly ReducerDecl[];
  readonly state?: DeclaredState;
  /** When `false`, downgrades the INCOMPLETE_DEPS check to a WARN. */
  readonly strict?: boolean;
}

export interface BoundaryInferenceResult {
  readonly schema: InferredSchema;
  /** Topologically-sorted computed-field names. */
  readonly computedOrder: readonly string[];
  /** Set of computed-field JSON pointer paths (for write-rejection). */
  readonly computedPaths: ReadonlySet<string>;
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Field-type helpers
// ---------------------------------------------------------------------------

export const ftUnknown = (): FieldType => ({ kind: 'unknown', confidence: 'unknown' });
export const ftKnown = (kind: Exclude<FieldKind, 'unknown'>): FieldType => ({
  kind,
  confidence: 'known',
});
export const ftNarrowed = (kind: FieldKind): FieldType => ({ kind, confidence: 'narrowed' });
export const ftArray = (element: FieldType, confidence: Confidence = 'known'): FieldType => ({
  kind: 'array',
  confidence,
  element,
});
export const ftObject = (
  fields: Record<string, FieldType>,
  confidence: Confidence = 'known',
): FieldType => ({ kind: 'object', confidence, fields });

/**
 * Least-Upper-Bound for two field types. Used when multiple writes to the
 * same state path produce different inferred types.
 */
export function lub(a: FieldType, b: FieldType): FieldType {
  if (a.kind === 'unknown' || b.kind === 'unknown') return ftUnknown();
  if (a.kind === b.kind) {
    if (a.kind === 'array') {
      const el = a.element && b.element ? lub(a.element, b.element) : ftUnknown();
      const confidence = mergeConfidence(a.confidence, b.confidence);
      return { kind: 'array', confidence, element: el };
    }
    if (a.kind === 'object') {
      const out: Record<string, FieldType> = {};
      const af = a.fields ?? {};
      const bf = b.fields ?? {};
      const keys = new Set([...Object.keys(af), ...Object.keys(bf)]);
      for (const k of keys) {
        if (af[k] && bf[k]) out[k] = lub(af[k], bf[k]);
        else out[k] = af[k] ?? bf[k] ?? ftUnknown();
      }
      const confidence = mergeConfidence(a.confidence, b.confidence);
      return { kind: 'object', confidence, fields: out };
    }
    // string|integer|number|boolean|null match exactly
    return { kind: a.kind, confidence: mergeConfidence(a.confidence, b.confidence) };
  }
  // integer + number → number (narrowed)
  if (
    (a.kind === 'integer' && b.kind === 'number') ||
    (a.kind === 'number' && b.kind === 'integer')
  ) {
    return ftNarrowed('number');
  }
  // Anything else differing → unknown
  return ftUnknown();
}

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  if (a === 'narrowed' || b === 'narrowed') return 'narrowed';
  return 'known';
}

// ---------------------------------------------------------------------------
// CEL type inference (textual — pattern-matching, not full AST evaluation)
// ---------------------------------------------------------------------------

const RE_STRING = /^\s*(['"])((?:\\.|(?!\1).)*)\1\s*$/;
const RE_NUMBER_INT = /^\s*-?\d+\s*$/;
const RE_NUMBER_DEC = /^\s*-?\d+\.\d+\s*$/;
const RE_BOOL = /^\s*(true|false)\s*$/;
const RE_NULL = /^\s*null\s*$/;
const RE_LENGTH_SIZE = /^\s*(length|size)\s*\(/;
const RE_SUM = /^\s*sum\s*\(/;
const RE_TERNARY = /^([^?]+)\?([^:]+):(.+)$/;
const RE_EVENT_REF = /^\s*event\.payload(?:\.([A-Za-z_$][\w$]*))+\s*$/;
const RE_STATE_REF = /^\s*state(?:\.([A-Za-z_$][\w$]*))+\s*$/;

// Infers FieldType from a CEL expression. Anything that doesn't match a
// known pattern returns `unknown` — callers tolerate that.
export function inferTypeFromCel(
  expr: string,
  eventSchema: Record<string, FieldType> | undefined,
  stateSchema: ReadonlyMap<string, InferredField>,
): FieldType {
  const trimmed = expr.trim();
  if (RE_STRING.test(trimmed)) return ftKnown('string');
  if (RE_NUMBER_INT.test(trimmed)) return ftKnown('integer');
  if (RE_NUMBER_DEC.test(trimmed)) return ftKnown('number');
  if (RE_BOOL.test(trimmed)) return ftKnown('boolean');
  if (RE_NULL.test(trimmed)) return ftKnown('null');
  if (RE_LENGTH_SIZE.test(trimmed)) return ftKnown('integer');
  if (RE_SUM.test(trimmed)) return ftKnown('number');

  // event.payload.X.Y... — walk into event schema
  const evMatch = trimmed.match(/^event\.payload((?:\.[A-Za-z_$][\w$]*)+)\s*$/);
  if (evMatch && eventSchema) {
    const path = evMatch[1].slice(1).split('.');
    let cur: FieldType | undefined = ftObject(eventSchema);
    for (const seg of path) {
      if (!cur || cur.kind !== 'object' || !cur.fields) return ftUnknown();
      cur = cur.fields[seg];
    }
    return cur ?? ftUnknown();
  }

  // state.X.Y... — walk into state schema
  const stMatch = trimmed.match(/^state((?:\.[A-Za-z_$][\w$]*)+)\s*$/);
  if (stMatch) {
    const path = stMatch[1].slice(1).split('.');
    const pointer = '/' + path.join('/');
    const direct = stateSchema.get(pointer);
    if (direct) return direct.type;
    // Try prefixes — maybe foo.bar but only /foo is known
    const head = '/' + path[0];
    const headField = stateSchema.get(head);
    if (headField && headField.type.kind === 'object' && headField.type.fields) {
      let cur: FieldType | undefined = headField.type;
      for (let i = 1; i < path.length; i++) {
        if (!cur || cur.kind !== 'object' || !cur.fields) return ftUnknown();
        cur = cur.fields[path[i]];
      }
      return cur ?? ftUnknown();
    }
    return ftUnknown();
  }

  // ternary: cond ? a : b  →  LUB(a, b)
  const tern = trimmed.match(RE_TERNARY);
  if (tern) {
    const aType = inferTypeFromCel(tern[2], eventSchema, stateSchema);
    const bType = inferTypeFromCel(tern[3], eventSchema, stateSchema);
    return lub(aType, bType);
  }

  // a + b  →  numeric if both numeric; string concat if either side is string.
  if (trimmed.includes('+') && !trimmed.startsWith('-')) {
    const parts = splitTopLevel(trimmed, '+');
    if (parts && parts.length === 2) {
      const lhs = inferTypeFromCel(parts[0], eventSchema, stateSchema);
      const rhs = inferTypeFromCel(parts[1], eventSchema, stateSchema);
      if (lhs.kind === 'string' || rhs.kind === 'string') return ftKnown('string');
      if (
        (lhs.kind === 'integer' || lhs.kind === 'number') &&
        (rhs.kind === 'integer' || rhs.kind === 'number')
      ) {
        if (lhs.kind === 'integer' && rhs.kind === 'integer') return ftKnown('integer');
        return ftNarrowed('number');
      }
      return ftUnknown();
    }
  }

  // {} or { k: v, ... }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return ftObject({}, 'known');
    return ftObject({}, 'narrowed'); // shallow — full inference of literal objects deferred
  }

  // [] or [...]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return ftArray(ftUnknown(), 'narrowed');
  }

  return ftUnknown();
}

/**
 * Split `expr` on the given single-character `sep` at the TOP nesting level
 * (not inside parens/brackets/braces/strings). Returns null on mismatched
 * delimiters or zero splits.
 */
function splitTopLevel(expr: string, sep: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let stringCh: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (stringCh) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === stringCh) stringCh = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      stringCh = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === sep && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  if (out.length < 2) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Schema build from events + reducer patches
// ---------------------------------------------------------------------------

interface MutableSchema {
  readonly fields: Map<string, { type: FieldType; sources: string[] }>;
}

function setOrMerge(
  s: MutableSchema,
  pointer: string,
  type: FieldType,
  source: string,
): void {
  const existing = s.fields.get(pointer);
  if (existing) {
    const merged = lub(existing.type, type);
    s.fields.set(pointer, {
      type: merged,
      sources: dedup([...existing.sources, source]),
    });
  } else {
    s.fields.set(pointer, { type, sources: [source] });
  }
}

function dedup<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function inferEventPayloadSchema(ev: EventDecl): Record<string, FieldType> {
  const out: Record<string, FieldType> = {};
  if (ev.template) {
    // Templates often reference event.payload.X — for the EVENT schema itself
    // we treat each declared field as `narrowed unknown` (its actual type
    // comes from incoming HTTP payloads).
    for (const k of Object.keys(ev.template)) {
      // For a payload literal field, look at the CEL expression — if it's
      // `event.payload.foo` we cannot resolve recursively here, so leave it
      // `unknown`. The CALLER (a reducer reading `event.payload.foo`) gets a
      // typed answer when the source event's template names that field, and
      // we settle into a fixed point.
      const expr = ev.template[k];
      out[k] = inferTypeFromCel(expr, undefined, new Map());
    }
  }
  if (ev.patches) {
    for (const p of ev.patches) {
      if (p.op === 'remove' || p.op === 'move' || p.op === 'copy') continue;
      const segs = parsePointer(p.path);
      if (segs.length !== 1) continue; // only top-level keys map directly
      const key = segs[0];
      const valueType = inferValueLiteral((p as { value?: unknown }).value);
      out[key] = valueType;
    }
  }
  return out;
}

function inferValueLiteral(v: unknown): FieldType {
  if (v === null) return ftKnown('null');
  switch (typeof v) {
    case 'string':
      return inferTypeFromCel(v, undefined, new Map());
    case 'number':
      return Number.isInteger(v) ? ftKnown('integer') : ftKnown('number');
    case 'boolean':
      return ftKnown('boolean');
    case 'object':
      if (Array.isArray(v)) return ftArray(ftUnknown(), 'narrowed');
      return ftObject({}, 'narrowed');
    default:
      return ftUnknown();
  }
}

// ---------------------------------------------------------------------------
// Patch path → state-field contribution
// ---------------------------------------------------------------------------

function walkReducerPatches(
  reducers: readonly ReducerDecl[],
  events: readonly EventDecl[],
  stateSchema: ReadonlyMap<string, InferredField>,
  out: MutableSchema,
): void {
  const eventSchemas = new Map<string, Record<string, FieldType>>();
  for (const ev of events) eventSchemas.set(ev.name, inferEventPayloadSchema(ev));

  for (const r of reducers) {
    if (!r.patches) continue;
    const eventSchema = eventSchemas.get(r.on);
    for (const p of r.patches) {
      const sourceTag = `reducer:${r.on}`;
      const path = (p as { path?: string }).path;
      if (!path) continue;
      const segs = parsePointer(path);
      if (segs.length === 0) continue;
      const pointer = '/' + segs.join('/');
      const valueLike = (p as { value?: unknown; by?: unknown }).value;

      switch (p.op) {
        case 'add':
        case 'replace':
        case 'append':
        case 'prepend': {
          const t = typeof valueLike === 'string'
            ? inferTypeFromCel(valueLike, eventSchema, stateSchema)
            : inferValueLiteral(valueLike);
          if (p.op === 'append' || p.op === 'prepend') {
            setOrMerge(out, pointer, ftArray(t, 'narrowed'), sourceTag);
          } else {
            setOrMerge(out, pointer, t, sourceTag);
          }
          break;
        }
        case 'increment':
          setOrMerge(out, pointer, ftKnown('number'), sourceTag);
          break;
        case 'merge':
        case 'upsert':
          setOrMerge(out, pointer, ftObject({}, 'narrowed'), sourceTag);
          break;
        case 'remove':
        case 'move':
        case 'copy':
          // Movement ops do not introduce a new type. The target inherits
          // the source — we leave that alone; LUB will sort it out.
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fixed-point iteration + cap
// ---------------------------------------------------------------------------

const MAX_INFERENCE_ITERATIONS = 4;

interface IterateOptions {
  readonly events: readonly EventDecl[];
  readonly reducers: readonly ReducerDecl[];
}

function iterateInference(opts: IterateOptions): {
  schema: Map<string, InferredField>;
  iterations: number;
  divergedFields: string[];
} {
  const cur: MutableSchema = { fields: new Map() };
  let prevHash = '';
  let iterations = 0;
  for (let i = 0; i < MAX_INFERENCE_ITERATIONS; i++) {
    iterations = i + 1;
    walkReducerPatches(opts.reducers, opts.events, freeze(cur), cur);
    const h = hashSchema(cur);
    if (h === prevHash) break;
    prevHash = h;
  }

  // Determine divergence: re-run once more; if hash changes again, those
  // fields are non-converged. We computed this lazily via the cap: if we
  // exited via the cap with prevHash still changing, then the last delta
  // names the diverged fields.
  let divergedFields: string[] = [];
  if (iterations === MAX_INFERENCE_ITERATIONS) {
    // run one extra speculative pass to detect any new diff
    const after: MutableSchema = { fields: new Map(cur.fields) };
    walkReducerPatches(opts.reducers, opts.events, freeze(after), after);
    const hAfter = hashSchema(after);
    if (hAfter !== prevHash) {
      // Identify fields whose entry differs
      const beforeMap = cur.fields;
      const afterMap = after.fields;
      for (const k of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
        if (JSON.stringify(beforeMap.get(k)) !== JSON.stringify(afterMap.get(k))) {
          divergedFields.push(k);
        }
      }
    }
  }

  return { schema: freeze(cur), iterations, divergedFields };
}

function freeze(s: MutableSchema): Map<string, InferredField> {
  const out = new Map<string, InferredField>();
  for (const [k, v] of s.fields) {
    out.set(k, { type: v.type, sources: [...v.sources] });
  }
  return out;
}

function hashSchema(s: MutableSchema): string {
  const keys = [...s.fields.keys()].sort();
  return keys.map((k) => `${k}=${JSON.stringify(s.fields.get(k))}`).join('|');
}

// ---------------------------------------------------------------------------
// Free-variable extraction
// ---------------------------------------------------------------------------

/**
 * Pull out every `state.X` (and `state.X.Y...`) reference from a CEL string.
 * Returns the first-level identifier — that is what `dependsOn:` uses.
 */
export function extractStateRefs(formula: string): string[] {
  const out = new Set<string>();
  const re = /\bstate\.([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Computed fields: cycle detection + topological sort
// ---------------------------------------------------------------------------

interface TopoResult {
  readonly order: string[];
  readonly cycle?: string[];
}

function topoSortComputed(fields: readonly DeclaredComputedField[]): TopoResult {
  const byName = new Map<string, DeclaredComputedField>(fields.map((f) => [f.name, f]));
  const computedSet = new Set(byName.keys());

  const color = new Map<string, 'white' | 'gray' | 'black'>();
  for (const f of fields) color.set(f.name, 'white');

  const order: string[] = [];
  const stack: string[] = [];

  function visit(name: string): string[] | null {
    const c = color.get(name);
    if (c === 'black') return null;
    if (c === 'gray') {
      // cycle — collect from first occurrence on stack
      const idx = stack.indexOf(name);
      return stack.slice(idx).concat(name);
    }
    color.set(name, 'gray');
    stack.push(name);
    const f = byName.get(name);
    if (f) {
      for (const dep of f.dependsOn) {
        if (!computedSet.has(dep)) continue; // dep is a non-computed (event/internal) field
        const cycleFound = visit(dep);
        if (cycleFound) return cycleFound;
      }
    }
    stack.pop();
    color.set(name, 'black');
    order.push(name);
    return null;
  }

  for (const f of fields) {
    const cycle = visit(f.name);
    if (cycle) return { order, cycle };
  }
  return { order };
}

// ---------------------------------------------------------------------------
// Main entry: build inferred schema for a boundary
// ---------------------------------------------------------------------------

export function buildInferredSchema(input: BoundaryInferenceInput): BoundaryInferenceResult {
  const strict = input.strict !== false;

  // Step 1: fixed-point inference over events + reducer patches.
  const { schema: inferred, iterations, divergedFields } = iterateInference({
    events: input.events,
    reducers: input.reducers,
  });

  if (divergedFields.length > 0) {
    throw new BootError(
      'BOOT_ERR_SCHEMA_INFERENCE_DIVERGENT',
      `Schema inference did not converge in ${iterations} iterations; fields: ${divergedFields.join(', ')}`,
      { boundary: input.boundary, fields: divergedFields, iterations },
    );
  }

  // Step 2: declared computed and internal fields merge in.
  const declaredComputed = input.state?.computed ?? [];
  const declaredInternal = input.state?.internal ?? [];

  // Shadow check: computed name MUST NOT collide
  // with a field inferred from EVENT templates. Reducer-patch contributions
  // are intentionally excluded — a reducer that writes a computed path
  // surfaces as a computed-field-write error (below) instead.
  const eventDerivedNames = new Set<string>();
  for (const ev of input.events) {
    if (ev.template) for (const k of Object.keys(ev.template)) eventDerivedNames.add(k);
    if (ev.patches) {
      for (const p of ev.patches) {
        if (p.op === 'remove' || p.op === 'move' || p.op === 'copy') continue;
        const segs = parsePointer((p as { path: string }).path);
        if (segs.length === 1) eventDerivedNames.add(segs[0]);
      }
    }
  }
  for (const cf of declaredComputed) {
    if (eventDerivedNames.has(cf.name)) {
      throw new BootError(
        'BOOT_ERR_COMPUTED_FIELD_SHADOWS_INFERRED',
        `Computed field "${cf.name}" shadows an event-derived state field`,
        { boundary: input.boundary, field: cf.name },
      );
    }
  }

  // Reducer patches must not write computed-field paths.
  const computedPaths = new Set<string>(declaredComputed.map((c) => '/' + c.name));
  for (const r of input.reducers) {
    if (!r.patches) continue;
    for (const p of r.patches) {
      const path = (p as { path?: string }).path;
      if (!path) continue;
      if (targetsComputed(path, computedPaths)) {
        throw new BootError(
          'BOOT_ERR_COMPUTED_FIELD_WRITE',
          `Reducer on "${r.on}" writes to computed-field path ${path}`,
          { boundary: input.boundary, event: r.on, op: p.op, path },
        );
      }
    }
  }

  // Internal fields: declared types take precedence over any inference for
  // the same name.
  const finalSchema = new Map<string, InferredField>(inferred);
  for (const inf of declaredInternal) {
    finalSchema.set('/' + inf.name, { type: inf.type, sources: ['declared:internal'] });
  }
  for (const cf of declaredComputed) {
    // Type comes from formula inference against the (so-far) known schema.
    // Build a partial event-context-free schema for the formula.
    const ft = inferTypeFromCel(cf.formula, undefined, finalSchema);
    finalSchema.set('/' + cf.name, { type: ft, sources: ['declared:computed'] });
  }

  // Step 3: topo sort + cycle detection.
  const topo = topoSortComputed(declaredComputed);
  if (topo.cycle) {
    throw new BootError(
      'BOOT_ERR_COMPUTED_FIELD_CYCLE',
      `Computed-field dependency cycle: ${topo.cycle.join(' → ')}`,
      { boundary: input.boundary, cycle: topo.cycle },
    );
  }

  // Step 4: free-variable check.
  const warnings: string[] = [];
  for (const cf of declaredComputed) {
    const refs = extractStateRefs(cf.formula);
    const declaredDeps = new Set(cf.dependsOn);
    const missing = refs.filter((r) => !declaredDeps.has(r));
    if (missing.length > 0) {
      const message = `Computed field "${cf.name}" formula references state.${missing.join(', state.')} but dependsOn is [${cf.dependsOn.join(', ')}]`;
      if (strict) {
        throw new BootError(
          'BOOT_ERR_COMPUTED_FIELD_INCOMPLETE_DEPS',
          message,
          { boundary: input.boundary, field: cf.name, missing, declared: [...cf.dependsOn] },
        );
      } else {
        warnings.push(message);
      }
    }
  }

  return {
    schema: finalSchema,
    computedOrder: topo.order,
    computedPaths,
    warnings,
  };
}

function targetsComputed(path: string, computedPaths: ReadonlySet<string>): boolean {
  for (const cp of computedPaths) {
    if (path === cp) return true;
    if (path.startsWith(cp + '/')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Adapter: canonical snake_case BoundaryConfig → BoundaryInferenceInput
// ---------------------------------------------------------------------------

/**
 * Map a compiled snake_case BoundaryConfig onto the inference input shape:
 *   eventCatalog[].{type,payloadTemplate} → events[].{name,template}
 *   reducers[].{on,patches}               → reducers[].{on,patches}
 *   state (computed/internal)             → state
 *   strictSchema                          → strict
 *
 * Reducer patch values use the ${...} template form; inference treats string
 * values textually (RE_* matchers strip the wrapper via inferTypeFromCel), so
 * the ReducerPatchOp list is passed straight through as Patch[].
 */
export function boundaryConfigToInferenceInput(
  boundary: BoundaryConfig,
): BoundaryInferenceInput {
  const events: EventDecl[] = boundary.eventCatalog.map((e) => ({
    name: e.type,
    template: { ...e.payloadTemplate },
  }));
  const reducers: ReducerDecl[] = boundary.reducers.map((r) => ({
    on: r.on,
    ...(r.patches ? { patches: r.patches as unknown as readonly Patch[] } : {}),
  }));
  return {
    boundary: boundary.boundary,
    events,
    reducers,
    ...(boundary.state ? { state: boundary.state } : {}),
    ...(boundary.strictSchema !== undefined ? { strict: boundary.strictSchema } : {}),
  };
}

// ---------------------------------------------------------------------------
// lint unused computed fields
// ---------------------------------------------------------------------------

export interface UsageContext {
  /** Strings that may textually contain `state.<name>` references. */
  readonly responseBodies?: readonly string[];
  /** Names emitted into the documented `/_engine/state` surface. */
  readonly stateSurfaceNames?: readonly string[];
}

export function lintUnusedComputed(
  computed: readonly DeclaredComputedField[],
  usage: UsageContext,
): string[] {
  const used = new Set<string>(usage.stateSurfaceNames ?? []);
  for (const body of usage.responseBodies ?? []) {
    for (const ref of extractStateRefs(body)) used.add(ref);
  }
  const out: string[] = [];
  for (const cf of computed) {
    if (!used.has(cf.name)) {
      out.push(`Computed field "${cf.name}" is declared but never read`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// topological recompute of computed fields touched by patches
// ---------------------------------------------------------------------------

export interface ComputedRecomputeEvaluator {
  /** Evaluate a CEL formula against the current state. */
  evaluate(formula: string, ctx: { state: Record<string, unknown> }): unknown;
}

/**
 * Recompute every declared computed field whose `dependsOn` intersects
 * `touchedPaths`. Order is the topological order produced by
 * `buildInferredSchema`. Mutates `state` in place (caller has already
 * cloned for atomicity).
 */
export function recomputeComputedFields(
  state: Record<string, unknown>,
  computed: readonly DeclaredComputedField[],
  computedOrder: readonly string[],
  touchedPaths: ReadonlySet<string>,
  evaluator: ComputedRecomputeEvaluator,
): void {
  const byName = new Map(computed.map((c) => [c.name, c]));
  const touchedTop = new Set<string>();
  for (const p of touchedPaths) {
    const segs = parsePointer(p);
    if (segs.length >= 1) touchedTop.add(segs[0]);
  }

  for (const name of computedOrder) {
    const cf = byName.get(name);
    if (!cf) continue;
    const deps = cf.dependsOn;
    const touched = deps.some((d) => touchedTop.has(d) || isComputedTouched(d, touchedTop, byName));
    if (!touched) continue;
    state[name] = evaluator.evaluate(cf.formula, { state }) ?? null;
    touchedTop.add(name); // downstream computed fields see this as touched
  }
}

function isComputedTouched(
  name: string,
  touched: ReadonlySet<string>,
  byName: ReadonlyMap<string, DeclaredComputedField>,
): boolean {
  if (touched.has(name)) return true;
  const cf = byName.get(name);
  if (!cf) return false;
  return cf.dependsOn.some((d) => isComputedTouched(d, touched, byName));
}
