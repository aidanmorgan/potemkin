/**
 * C2: Parameter substitution engine for component definitions.
 *
 * Resolves {{name}} tokens in string leaves of a ComponentDefinition against
 * the declared parameters block, with full type validation. CEL ${...}
 * expressions are left byte-for-byte unchanged.
 *
 * Substitution rules:
 *  - A string that is EXACTLY "{{name}}" substitutes the typed value
 *    (string, number, or boolean). The caller receives the native JS type.
 *  - A "{{name}}" token EMBEDDED within a larger string always yields a
 *    string (the parameter value coerced via String()).
 *  - An unknown {{token}} (no matching declared parameter) is an error.
 *  - CEL ${...} spans are copied through unchanged.
 *
 * Error codes:
 *  - BOOT_ERR_DSL_SYNTAX: missing required parameter, type mismatch,
 *    unknown {{token}}, or unknown arg (not in parameters block).
 */

import { BootError } from '../errors.js';
import type {
  BehaviorRule,
  ComponentDefinition,
  EventCatalogEntry,
  IdentityConfig,
  IncludeEntry,
  ReactionRule,
  ReducerPatchOp,
  ReducerRule,
} from './types.js';
import type { DeclaredState } from './schemaInference.js';

// ---------------------------------------------------------------------------
// Token detection
// ---------------------------------------------------------------------------

/** Regex that detects any {{...}} token in a string (non-greedy). */
const TOKEN_RE = /\{\{([^}]+)\}\}/g;

/** Returns true when the entire string is a single {{name}} token. */
function isExactToken(s: string): boolean {
  return /^\{\{([^}]+)\}\}$/.test(s);
}

/** Extract the parameter name from an exact "{{name}}" string. */
function exactTokenName(s: string): string {
  return s.slice(2, s.length - 2);
}

// ---------------------------------------------------------------------------
// Resolved parameter map
// ---------------------------------------------------------------------------

type ResolvedParams = ReadonlyMap<string, string | number | boolean>;

/**
 * Build the resolved parameter map: apply defaults, overlay args, enforce
 * required, type-check, and reject unknown args.
 */
function resolveParameters(
  parameters: ComponentDefinition['parameters'],
  args: Record<string, string | number | boolean>,
  componentName: string,
): ResolvedParams {
  const ctx = `component "${componentName}"`;

  // Reject args for undeclared parameters.
  for (const argName of Object.keys(args)) {
    if (!parameters || !(argName in parameters)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: unknown parameter "${argName}" — not declared in parameters block`,
        { parameter: argName, component: componentName },
      );
    }
  }

  const out = new Map<string, string | number | boolean>();

  for (const [paramName, decl] of Object.entries(parameters ?? {})) {
    const pctx = `${ctx}.parameters.${paramName}`;
    const supplied = Object.prototype.hasOwnProperty.call(args, paramName);
    const raw = supplied ? args[paramName] : decl.default;

    if (raw === undefined) {
      if (decl.required) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${pctx}: required parameter "${paramName}" was not supplied`,
          { parameter: paramName, component: componentName },
        );
      }
      // Optional, no default, no arg — leave absent (no substitution token
      // referencing it will appear in well-authored YAML, but if one does the
      // substituteTokens call will throw BOOT_ERR_DSL_SYNTAX at token-walk time).
      continue;
    }

    // Type-check the value against the declared type.
    const jsType = typeof raw;
    if (jsType !== decl.type) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${pctx}: parameter "${paramName}" expects type ${decl.type} but received ${jsType} (${JSON.stringify(raw)})`,
        { parameter: paramName, expected: decl.type, received: jsType, component: componentName },
      );
    }

    out.set(paramName, raw);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Token substitution in a single string
// ---------------------------------------------------------------------------

/**
 * Substitute {{name}} tokens in a single string value.
 *
 * - Exact match ("{{name}}" with no surrounding text): returns the native
 *   typed value (string | number | boolean).
 * - Embedded token: coerces to string with String().
 * - Unknown token: throws BOOT_ERR_DSL_SYNTAX.
 * - CEL ${...} spans: not matched by TOKEN_RE; passed through unchanged.
 */
export function substituteTokens(
  value: string,
  resolved: ResolvedParams,
  componentName: string,
): string | number | boolean {
  // Fast path: no token present.
  if (!value.includes('{{')) return value;

  // Exact single-token substitution (preserves native type).
  if (isExactToken(value)) {
    const name = exactTokenName(value);
    if (!resolved.has(name)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `component "${componentName}": unknown token "{{${name}}}" — no declared parameter with that name`,
        { token: name, component: componentName },
      );
    }
    return resolved.get(name)!;
  }

  // Embedded-token substitution (always yields a string).
  TOKEN_RE.lastIndex = 0;
  return value.replace(TOKEN_RE, (_match, name: string) => {
    if (!resolved.has(name)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `component "${componentName}": unknown token "{{${name}}}" — no declared parameter with that name`,
        { token: name, component: componentName },
      );
    }
    return String(resolved.get(name)!);
  });
}

// ---------------------------------------------------------------------------
// Deep-walk helpers (value substitution + key substitution)
// ---------------------------------------------------------------------------

/**
 * Walk an arbitrary JSON-compatible value and substitute {{...}} tokens in
 * every string leaf (both object values and object keys).
 */
function walkValue(
  v: unknown,
  resolved: ResolvedParams,
  componentName: string,
): unknown {
  if (typeof v === 'string') {
    return substituteTokens(v, resolved, componentName);
  }
  if (Array.isArray(v)) {
    return v.map((item) => walkValue(item, resolved, componentName));
  }
  if (v !== null && typeof v === 'object') {
    return walkRecord(v as Record<string, unknown>, resolved, componentName);
  }
  // number, boolean, null — no tokens possible
  return v;
}

function walkRecord(
  obj: Record<string, unknown>,
  resolved: ResolvedParams,
  componentName: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Substitute tokens in the key too (e.g. JSON-Pointer path segments used as keys).
    const newKey = typeof k === 'string' ? String(substituteTokens(k, resolved, componentName)) : k;
    out[newKey] = walkValue(v, resolved, componentName);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed sub-section helpers
// These cast the walked output back to the correct DSL types. The walk
// preserves the object shape; casting is safe because substituteTokens only
// changes string content, never structural types.
// ---------------------------------------------------------------------------

function walkEventCatalog(
  entries: readonly EventCatalogEntry[] | undefined,
  resolved: ResolvedParams,
  componentName: string,
): readonly EventCatalogEntry[] | undefined {
  if (!entries) return undefined;
  return entries.map((e) => walkValue(e, resolved, componentName) as EventCatalogEntry);
}

function walkReducers(
  rules: readonly ReducerRule[] | undefined,
  resolved: ResolvedParams,
  componentName: string,
): readonly ReducerRule[] | undefined {
  if (!rules) return undefined;
  return rules.map((r) => {
    const walked = walkRecord(r as unknown as Record<string, unknown>, resolved, componentName);
    // patches is readonly ReducerPatchOp[] — preserve it correctly
    if (r.patches !== undefined) {
      walked['patches'] = r.patches.map(
        (p) => walkRecord(p as unknown as Record<string, unknown>, resolved, componentName) as unknown as ReducerPatchOp,
      );
    }
    return walked as unknown as ReducerRule;
  });
}

function walkBehaviors(
  rules: readonly BehaviorRule[] | undefined,
  resolved: ResolvedParams,
  componentName: string,
): readonly BehaviorRule[] | undefined {
  if (!rules) return undefined;
  return rules.map((b) => walkValue(b, resolved, componentName) as BehaviorRule);
}

function walkReactions(
  rules: readonly ReactionRule[] | undefined,
  resolved: ResolvedParams,
  componentName: string,
): readonly ReactionRule[] | undefined {
  if (!rules) return undefined;
  return rules.map((r) => walkValue(r, resolved, componentName) as ReactionRule);
}

function walkInclude(
  entries: readonly IncludeEntry[] | undefined,
  resolved: ResolvedParams,
  componentName: string,
): readonly IncludeEntry[] | undefined {
  if (!entries) return undefined;
  return entries.map((e) => walkValue(e, resolved, componentName) as IncludeEntry);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the effective parameter values for a component and substitute all
 * {{name}} tokens throughout the component's string leaves (values and keys).
 *
 * @param component  The parsed ComponentDefinition (as produced by C1).
 * @param args       Parameter bindings supplied by the caller (e.g. `with:` block).
 * @returns          A new ComponentDefinition with all {{...}} tokens replaced.
 * @throws {BootError} BOOT_ERR_DSL_SYNTAX for any parameter resolution or
 *                     token substitution failure.
 */
export function substituteParameters(
  component: ComponentDefinition,
  args: Record<string, string | number | boolean>,
): ComponentDefinition {
  const resolved = resolveParameters(component.parameters, args, component.name);

  return {
    kind: 'component',
    name: component.name,
    ...(component.parameters !== undefined ? { parameters: component.parameters } : {}),
    ...(component.eventCatalog !== undefined
      ? { eventCatalog: walkEventCatalog(component.eventCatalog, resolved, component.name) }
      : {}),
    ...(component.reducers !== undefined
      ? { reducers: walkReducers(component.reducers, resolved, component.name) }
      : {}),
    ...(component.behaviors !== undefined
      ? { behaviors: walkBehaviors(component.behaviors, resolved, component.name) }
      : {}),
    ...(component.identity !== undefined
      ? { identity: walkValue(component.identity, resolved, component.name) as IdentityConfig }
      : {}),
    ...(component.state !== undefined
      ? { state: walkValue(component.state, resolved, component.name) as DeclaredState }
      : {}),
    ...(component.reactions !== undefined
      ? { reactions: walkReactions(component.reactions, resolved, component.name) }
      : {}),
    ...(component.include !== undefined
      ? { include: walkInclude(component.include, resolved, component.name) }
      : {}),
  };
}
