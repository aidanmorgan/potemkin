/**
 * HATEOAS / hypermedia link computation.
 *
 * Driven by `hateoas:` config in global.yaml. Adds `_links` to query responses:
 *   - self: link to the entity's own GET path (when `self_links` is true, default).
 *   - action links: sub-path boundaries whose `behavior.linkName` is set AND whose
 *     `match.condition` evaluates true against the entity's current state.
 *
 * Public API:
 *   - {@link applyHateoasLinks} — apply HATEOAS to a query response body (single
 *     entity, raw array, or pagination envelope). Designed to be called AFTER
 *     OpenAPI response validation so the additive `_links` field does not cause
 *     contract violations. This mirrors the post-validation pattern used by
 *     {@link applyRelationshipExpansion} in src/engine/query.ts.
 */

import type { JsonObject, JsonValue } from '../types.js';
import type { BoundaryConfig, CompiledDsl } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import { CelPhase } from '../cel/phases.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HateoasLink {
  readonly href: string;
  readonly method?: string;
}

export interface HateoasInput {
  readonly entity: JsonObject;
  readonly boundary: BoundaryConfig;
  readonly dsl: CompiledDsl;
  readonly cel: CelEvaluator;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Substitute `{id}` (and any other path template variables) in a contractPath
 * with the entity's id. Non-id template segments are left untouched.
 */
function expandPath(contractPath: string, id: string): string {
  return contractPath.replace(/\{id\}/g, encodeURIComponent(id));
}

/**
 * Return the entity's id from a typical "state" object. Falls back to null when
 * absent or non-string (links are skipped in that case).
 */
function readEntityId(entity: JsonObject): string | null {
  const raw = entity['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Resolve the canonical single-entity contract path for an entity belonging to
 * `boundary`. When the boundary's contractPath already contains `{id}` (e.g.
 * `/leads/{id}`), that template is used directly. Otherwise we look for a
 * sibling boundary whose contractPath is `boundary.contractPath + "/{id}"`
 * (i.e. the LeadById-style boundary attached to a collection boundary).
 *
 * Returns null when no suitable path can be resolved — callers should skip
 * the self link in that case.
 */
function resolveEntityPathTemplate(
  boundary: BoundaryConfig,
  dsl: CompiledDsl,
): string | null {
  if (boundary.contractPath.includes('{id}')) {
    return boundary.contractPath;
  }
  const sibling = dsl.boundaries.find(
    b => b.contractPath === `${boundary.contractPath}/{id}`,
  );
  return sibling ? sibling.contractPath : null;
}

/**
 * Evaluate a behavior's match.condition (CEL) against the entity's state.
 * Returns false if the condition is not a string, is empty, throws during
 * evaluation, or evaluates to a non-true value.
 *
 * The entity is exposed as `state` (mirroring CelContext used elsewhere in the
 * engine, e.g. queryMapping filters and x-derived properties).
 */
function evaluateBehaviorMatch(
  condition: string | undefined,
  entity: JsonObject,
  cel: CelEvaluator,
): boolean {
  if (typeof condition !== 'string' || condition.trim() === '') return false;
  // Trivial-true short-circuit — common in sub-path boundaries where the path
  // itself is the match and the condition is simply "true". Skip CEL eval.
  if (condition.trim() === 'true') return true;
  try {
    const result = cel.evaluateDslValue(
      condition,
      { state: entity as Record<string, unknown> },
      CelPhase.Behavior,
    );
    return result === true;
  } catch {
    // Treat any CEL failure (missing field, type error, etc.) as "link not
    // available" — never include a link whose precondition cannot be verified.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core: per-entity link computation
// ---------------------------------------------------------------------------

/**
 * Compute the `_links` object for a single entity. Returns null when HATEOAS
 * is disabled in the DSL configuration (signalling the caller to leave the
 * response untouched).
 *
 * Algorithm:
 *  1. If `dsl.hateoas?.enabled` is false/undefined → return null.
 *  2. Build the self link (when `selfLinks` is true; default).
 *  3. Scan every other boundary in dsl.boundaries:
 *     - Its contractPath must start with `<boundary.contractPath>/` (sub-path).
 *     - It must declare at least one behavior with `linkName` set whose
 *       match.condition currently evaluates to true against entity state.
 *     - For the first such matching behavior, add a link entry keyed by
 *       linkName pointing at the expanded sub-path.
 */
export function computeLinks(input: HateoasInput): Record<string, HateoasLink> | null {
  const { entity, boundary, dsl, cel } = input;

  const hateoas = dsl.hateoas;
  if (!hateoas?.enabled) return null;

  const id = readEntityId(entity);
  if (id === null) {
    // Without an id we cannot expand any href — emit no links.
    return {};
  }

  const links: Record<string, HateoasLink> = {};

  // The entity's canonical GET path template. For a collection boundary like
  // `Lead` (path `/leads`), this resolves to the sibling single-entity path
  // `/leads/{id}` (e.g. `LeadById`). For a boundary that already represents a
  // single entity (path already contains `{id}`), this is just the boundary's
  // own contractPath.
  const entityPathTemplate = resolveEntityPathTemplate(boundary, dsl);

  // 1. Self link (default-on; opt-out via self_links: false).
  const includeSelf = hateoas.selfLinks !== false;
  if (includeSelf && entityPathTemplate !== null) {
    links['self'] = {
      href: expandPath(entityPathTemplate, id),
      method: 'GET',
    };
  }

  // 2. Action links — sub-path boundaries with link_name behaviors.
  // Detection uses path templates (not substituted): sub-paths are boundaries
  // whose contractPath starts with `<entityPathTemplate>/`.
  if (entityPathTemplate === null) return links;
  const ownPathPrefix = entityPathTemplate.endsWith('/')
    ? entityPathTemplate
    : `${entityPathTemplate}/`;

  for (const other of dsl.boundaries) {
    if (other.boundary === boundary.boundary) continue;
    if (!other.contractPath.startsWith(ownPathPrefix)) continue;

    for (const behavior of other.behaviors) {
      const linkName = behavior.linkName;
      if (typeof linkName !== 'string' || linkName.length === 0) continue;
      if (Object.prototype.hasOwnProperty.call(links, linkName)) continue;

      // The link gate is `linkCondition` when explicitly set; otherwise it
      // falls back to the runtime `match.condition` (matches the design intent
      // when condition is state-aware, e.g. lead-convert/lead-disqualify).
      const gate = behavior.linkCondition ?? behavior.match.condition;
      if (!evaluateBehaviorMatch(gate, entity, cel)) continue;

      links[linkName] = {
        href: expandPath(other.contractPath, id),
        method: behavior.match.method,
      };
      // First matching behavior per boundary wins; stop scanning this boundary.
      break;
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// Public application: attach _links to a query response body
// ---------------------------------------------------------------------------

export interface ApplyHateoasInput {
  readonly body: JsonValue;
  readonly boundary: BoundaryConfig;
  readonly dsl: CompiledDsl;
  readonly cel: CelEvaluator;
  /**
   * Optional query params from the originating request. When present and the
   * client supplied `?fields=`, HATEOAS is skipped: a sparse-fieldset request
   * is an explicit projection and adding `_links` would leak an unrequested
   * property into the response.
   */
  readonly queryParams?: Record<string, string | string[]>;
}

/**
 * Apply HATEOAS `_links` to a query response body.
 *
 * Handles three shapes:
 *   - Pagination envelope `{ items: [...], totalCount, offset, limit, hasMore }`
 *     → each item in `items` receives its own `_links`.
 *   - Raw array (collection query without ?limit envelope) → each entry
 *     receives `_links`.
 *   - Single object → receives `_links`.
 *
 * No-op when:
 *   - `dsl.hateoas` is undefined or `enabled` is false.
 *   - The body is null, a scalar, or an object that lacks an id (`computeLinks`
 *     returns an empty record in that case; we skip attaching).
 *   - `?fields=` is present in the request: sparse fieldsets are an explicit
 *     projection contract and adding `_links` would violate it.
 *
 * This function never throws; CEL evaluation failures inside per-link
 * conditions are swallowed by {@link computeLinks}.
 */
export function applyHateoasLinks(input: ApplyHateoasInput): JsonValue {
  const { body, boundary, dsl, cel, queryParams } = input;

  if (!dsl.hateoas?.enabled) return body;
  if (queryParams !== undefined && queryParams['fields'] !== undefined) return body;
  if (body === null || typeof body !== 'object') return body;

  // Pagination envelope: { items: [...], totalCount, offset, limit, hasMore }
  if (!Array.isArray(body)) {
    const obj = body as Record<string, JsonValue>;
    if (Array.isArray(obj['items'])) {
      const items = obj['items'] as JsonValue[];
      const enriched = items.map((item) => attachLinks(item, boundary, dsl, cel));
      return { ...obj, items: enriched as unknown as JsonValue } as JsonValue;
    }
    // Single-entity object
    return attachLinks(body as JsonValue, boundary, dsl, cel);
  }

  // Raw array (collection without envelope)
  return (body as JsonValue[]).map((item) => attachLinks(item, boundary, dsl, cel)) as JsonValue;
}

/**
 * Attach `_links` to a single JsonValue when it is an entity-shaped object.
 * Non-object values are returned unchanged.
 */
function attachLinks(
  value: JsonValue,
  boundary: BoundaryConfig,
  dsl: CompiledDsl,
  cel: CelEvaluator,
): JsonValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;

  const entity = value as JsonObject;
  const links = computeLinks({ entity, boundary, dsl, cel });
  if (links === null) return value;

  return { ...entity, _links: links as unknown as JsonValue };
}
