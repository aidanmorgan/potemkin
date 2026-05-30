import type { CompiledDsl } from '../dsl/types.js';
import type { ObjectGraphSchemaRegistry } from './types.js';
import { pathExists } from './pathResolver.js';
import { getTracer, withSpan } from '../observability/tracing.js';
import { childLogger, rootLogger } from '../observability/logger.js';

export type DslCheckError = {
  code: 'DSL_PATH_UNKNOWN' | 'DSL_TYPE_MISMATCH' | 'DSL_BOUNDARY_UNKNOWN';
  boundary: string;
  location: string;
  detail: string;
};

// ── CEL path extraction ────────────────────────────────────────────────────────

/**
 * Extract `state.X.Y.Z` access paths from a CEL expression string.
 * Returns only paths rooted at `state.` (i.e. `state` itself is skipped;
 * we return the remainder after `state.`).
 * Dynamic accesses (e.g. `state[var]`) are silently skipped.
 */
function extractStatePaths(celExpr: string): string[] {
  // Match state.ident(.ident)* — stop at non-ident/non-dot characters
  const re = /\bstate\.([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(celExpr)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

// ── checker ───────────────────────────────────────────────────────────────────

export async function staticCheckDsl(
  dsl: CompiledDsl,
  registry: ObjectGraphSchemaRegistry,
): Promise<readonly DslCheckError[]> {
  const log = childLogger(rootLogger(), { module: 'schema.staticCheckDsl' });
  return withSpan(getTracer(), 'schema.staticCheckDsl', () => {
    const errors: DslCheckError[] = [];

    for (const bc of dsl.boundaries) {
      const { boundary } = bc;

      // Verify the boundary has a schema
      if (!registry.get(boundary)) {
        errors.push({
          code: 'DSL_BOUNDARY_UNKNOWN',
          boundary,
          location: `boundary:${boundary}`,
          detail: `No schema found for boundary '${boundary}'`,
        });
        log.warn({ boundary }, 'DSL_BOUNDARY_UNKNOWN: no schema for boundary');
        continue;
      }

      // ── Behaviors ──────────────────────────────────────────────────────────
      for (const behavior of bc.behaviors) {
        const condition = behavior.match.condition;
        if (condition) {
          for (const p of extractStatePaths(condition)) {
            if (!pathExists(registry, boundary, p)) {
              errors.push({
                code: 'DSL_PATH_UNKNOWN',
                boundary,
                location: `behavior:${behavior.name}:condition`,
                detail: `Unknown state path 'state.${p}' in condition`,
              });
              log.warn({ boundary, path: p, behavior: behavior.name }, 'DSL_PATH_UNKNOWN in behavior condition');
            }
          }
        }

        // ── Dispatch commands ─────────────────────────────────────────────
        for (const cmd of behavior.dispatchCommands ?? []) {
          // Check targetId CEL expression
          for (const p of extractStatePaths(cmd.targetId)) {
            if (!pathExists(registry, boundary, p)) {
              errors.push({
                code: 'DSL_PATH_UNKNOWN',
                boundary,
                location: `behavior:${behavior.name}:dispatchCommands:targetId`,
                detail: `Unknown state path 'state.${p}' in dispatchCommands targetId`,
              });
              log.warn({ boundary, path: p, behavior: behavior.name }, 'DSL_PATH_UNKNOWN in dispatchCommands targetId');
            }
          }
          // Check payload CEL expressions
          for (const [field, cel] of Object.entries(cmd.payload ?? {})) {
            for (const p of extractStatePaths(cel)) {
              if (!pathExists(registry, boundary, p)) {
                errors.push({
                  code: 'DSL_PATH_UNKNOWN',
                  boundary,
                  location: `behavior:${behavior.name}:dispatchCommands:payload:${field}`,
                  detail: `Unknown state path 'state.${p}' in dispatchCommands payload`,
                });
                log.warn({ boundary, path: p, behavior: behavior.name }, 'DSL_PATH_UNKNOWN in dispatchCommands payload');
              }
            }
          }
        }
      }

      // ── Reducers ───────────────────────────────────────────────────────────
      for (const reducer of bc.reducers) {
        for (const patch of reducer.patches ?? []) {
          // The patch path (RFC 6901 pointer) targets a dot-path in the entity.
          // Skip array-position segments (numeric indices and the `-` end
          // sentinel) — they address elements, not schema-declared properties.
          const dotPath = patch.path
            .replace(/^\//, '')
            .split('/')
            .filter((seg) => seg !== '-' && !/^\d+$/.test(seg))
            .join('.');
          if (dotPath !== '' && !pathExists(registry, boundary, dotPath)) {
            errors.push({
              code: 'DSL_PATH_UNKNOWN',
              boundary,
              location: `reducer:${reducer.on}:patches:${patch.path}`,
              detail: `Unknown patch path '${patch.path}'`,
            });
            log.warn({ boundary, path: patch.path, event: reducer.on }, 'DSL_PATH_UNKNOWN in reducer patch');
          }
          // A patch's CEL value expression may contain state.X.Y reads.
          if (typeof patch.value === 'string') {
            for (const p of extractStatePaths(patch.value)) {
              if (!pathExists(registry, boundary, p)) {
                errors.push({
                  code: 'DSL_PATH_UNKNOWN',
                  boundary,
                  location: `reducer:${reducer.on}:patches:${patch.path}:cel`,
                  detail: `Unknown state path 'state.${p}' in patch CEL`,
                });
                log.warn({ boundary, path: p, event: reducer.on }, 'DSL_PATH_UNKNOWN in reducer patch CEL');
              }
            }
          }
        }
      }

      // ── Event catalog payload templates ────────────────────────────────────
      for (const entry of bc.eventCatalog) {
        for (const [field, cel] of Object.entries(entry.payloadTemplate)) {
          for (const p of extractStatePaths(cel)) {
            if (!pathExists(registry, boundary, p)) {
              errors.push({
                code: 'DSL_PATH_UNKNOWN',
                boundary,
                location: `eventCatalog:${entry.type}:payloadTemplate:${field}`,
                detail: `Unknown state path 'state.${p}' in event payload template`,
              });
              log.warn({ boundary, path: p, eventType: entry.type }, 'DSL_PATH_UNKNOWN in event catalog template');
            }
          }
        }
      }
    }

    log.info({ errorCount: errors.length }, 'DSL static schema check complete');
    return errors;
  }, { 'dsl.boundaryCount': dsl.boundaries.length });
}
