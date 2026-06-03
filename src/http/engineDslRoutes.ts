// Express mount for POST /_engine/dsl and GET /_engine/state/:boundary/:id.
// The pure-logic handler in engineDslHandler.ts is wired here against
// production InstallStore / StateAccessor / InstallProducer implementations
// that delegate to the live engine.

import type { Express, Request, Response } from 'express';
import express from 'express';

import type { BootedSystem } from '../engine/boot.js';
import type { CompiledDsl } from '../dsl/types.js';
import type { DomainEvent } from '../types.js';
import { compileDsl } from '../dsl/parser.js';
import { validateBoundaryTsRefs } from '../dsl/schema.js';
import {
  buildInferredSchema,
  boundaryConfigToInferenceInput,
  type BoundaryInferenceResult,
} from '../dsl/schemaInference.js';
import { deriveSchemasFromOpenApi } from '../schema/fromOpenApi.js';
import type { ObjectGraphSchemaRegistry, BoundarySchemas } from '../schema/types.js';
import { buildPreconditionMap } from '../engine/boot.js';
import { computeSpecVersion } from '../dsl/specVersion.js';
import { createCelEvaluator } from '../cel/evaluator.js';
import { createStateGraph } from '../stategraph/graph.js';
import { projectEvent } from '../engine/projection.js';
import type { JournalEntry } from '../dsl/patches.js';
import {
  handleEngineDsl,
  handleEngineState,
  type DslInstallStore,
  type InstalledBundle,
  type InstallProducer,
  type StateAccessor,
  type StateBundle,
} from './engineDslHandler.js';

/**
 * Merge boundary-derived fields from freshDsl with global-config fields
 * carried over from existingDsl when the push did not supply them.
 *
 * Boundary-scoped fields (boundaries, byContractPath, byBoundaryName,
 * scriptRegistry) always come from freshDsl — these are what the push
 * legitimately replaces.
 *
 * Global fields (sagas, auth, webhooks, faults, hateoas, versioning,
 * securityHeaders, idempotency, derivedProjections) are taken from
 * freshDsl when present, otherwise fall back to existingDsl so that
 * a boundary-only push does not erase config loaded from potemkin.yaml.
 */
export function mergeGlobalConfig(freshDsl: CompiledDsl, existingDsl: CompiledDsl): CompiledDsl {
  return {
    // ── boundary-scoped: always from the fresh compile ───────────────────
    boundaries: freshDsl.boundaries,
    byContractPath: freshDsl.byContractPath,
    byBoundaryName: freshDsl.byBoundaryName,
    scriptRegistry: freshDsl.scriptRegistry,
    // ── global fields: fresh wins; fall back to existing ─────────────────
    ...(freshDsl.sagas !== undefined
      ? { sagas: freshDsl.sagas }
      : existingDsl.sagas !== undefined
        ? { sagas: existingDsl.sagas }
        : {}),
    ...(freshDsl.auth !== undefined
      ? { auth: freshDsl.auth }
      : existingDsl.auth !== undefined
        ? { auth: existingDsl.auth }
        : {}),
    ...(freshDsl.webhooks !== undefined
      ? { webhooks: freshDsl.webhooks }
      : existingDsl.webhooks !== undefined
        ? { webhooks: existingDsl.webhooks }
        : {}),
    ...(freshDsl.faults !== undefined
      ? { faults: freshDsl.faults }
      : existingDsl.faults !== undefined
        ? { faults: existingDsl.faults }
        : {}),
    ...(freshDsl.hateoas !== undefined
      ? { hateoas: freshDsl.hateoas }
      : existingDsl.hateoas !== undefined
        ? { hateoas: existingDsl.hateoas }
        : {}),
    ...(freshDsl.versioning !== undefined
      ? { versioning: freshDsl.versioning }
      : existingDsl.versioning !== undefined
        ? { versioning: existingDsl.versioning }
        : {}),
    ...(freshDsl.securityHeaders !== undefined
      ? { securityHeaders: freshDsl.securityHeaders }
      : existingDsl.securityHeaders !== undefined
        ? { securityHeaders: existingDsl.securityHeaders }
        : {}),
    ...(freshDsl.idempotency !== undefined
      ? { idempotency: freshDsl.idempotency }
      : existingDsl.idempotency !== undefined
        ? { idempotency: existingDsl.idempotency }
        : {}),
    ...(freshDsl.derivedProjections !== undefined
      ? { derivedProjections: freshDsl.derivedProjections }
      : existingDsl.derivedProjections !== undefined
        ? { derivedProjections: existingDsl.derivedProjections }
        : {}),
  };
}

// In-memory installed-bundle holder. Survives across requests.
class InMemoryInstallStore implements DslInstallStore {
  private bundle: InstalledBundle | null = null;
  get(): InstalledBundle | null {
    return this.bundle;
  }
  async install(b: InstalledBundle): Promise<void> {
    this.bundle = b;
  }
}

function makeInstallProducer(sys: BootedSystem): InstallProducer {
  return {
    async install(payload): Promise<InstalledBundle> {
      // Compile the bundle's YAML modules into a CompiledDsl and swap it
      // onto the BootedSystem so subsequent requests see the new DSL.
      const modules = payload.modules.map((m) => ({ name: m.path, yaml: m.yaml }));
      const freshDsl = await compileDsl(modules);
      // Fail fast on a pushed boundary whose ts:<id> resolves to neither an inline
      // script in this bundle nor a scanned @Script known to the running system —
      // the same guard boot applies, restored on the hot-push path (the push does
      // not re-scan, so scanned ids come from the booted system).
      for (const boundary of freshDsl.boundaries) {
        validateBoundaryTsRefs(boundary, sys.scannedScriptIds);
      }
      // Preserve global-config fields (sagas, auth, webhooks, faults, etc.)
      // from the current sys.dsl so a boundary-only push does not erase
      // config loaded from potemkin.yaml at boot time.
      const dsl = mergeGlobalConfig(freshDsl, sys.dsl);

      // Rebuild EVERY boundary-derived structure boot derives from dsl.boundaries
      // so the whole BootedSystem stays consistent after the swap — not just
      // sys.dsl. Leaving any of these stale silently degrades the write path for
      // boundaries newly bound (via push) onto existing OpenAPI paths:
      //   - inferredSchemas: computed-field order / internal fields
      //   - schemaRegistry:  runtime type guard (SCHEMA_TYPE_MISMATCH protection)
      //   - requiresPrecondition: If-Match optimistic-concurrency enforcement
      // All are pure functions of (sys.openapi, dsl.boundaries); we compute them
      // into locals first, then assign together so the swap is coherent.
      const inferredSchemas: Record<string, BoundaryInferenceResult> = {};
      for (const boundary of dsl.boundaries) {
        inferredSchemas[boundary.boundary] = buildInferredSchema(
          boundaryConfigToInferenceInput(boundary),
        );
      }
      // Tolerant schema rebuild: boot REJECTS a boundary with no OpenAPI schema,
      // but a hot push legitimately carries boundaries that may not be
      // OpenAPI-bound (Specmatic pushes what it discovered). Build the registry
      // per-boundary, skipping boundaries that have no schema — so the runtime
      // type guard is applied wherever a schema EXISTS (fixing the staleness for
      // boundaries bound to existing paths) without rejecting the push where it
      // doesn't (preserving the pre-fix accept-behavior for unbound boundaries).
      const byBoundary: Record<string, BoundarySchemas> = {};
      for (const boundary of dsl.boundaries) {
        try {
          const schema = deriveSchemasFromOpenApi(sys.openapi, [boundary]).get(boundary.boundary);
          if (schema) byBoundary[boundary.boundary] = schema;
        } catch {
          // Boundary not bound to an OpenAPI schema — no type guard for it.
        }
      }
      const schemaRegistry: ObjectGraphSchemaRegistry = {
        byBoundary,
        get(boundary: string): BoundarySchemas | undefined {
          return byBoundary[boundary];
        },
      };
      const requiresPrecondition = buildPreconditionMap(sys.openapi, dsl.boundaries);

      // Coherent swap: the graph is left untouched so projected state survives.
      (sys as {
        dsl: typeof dsl;
        inferredSchemas: typeof inferredSchemas;
        schemaRegistry: ObjectGraphSchemaRegistry;
        requiresPrecondition: typeof requiresPrecondition;
      }).dsl = dsl;
      (sys as { inferredSchemas: typeof inferredSchemas }).inferredSchemas = inferredSchemas;
      (sys as { schemaRegistry: ObjectGraphSchemaRegistry }).schemaRegistry = schemaRegistry;
      (sys as { requiresPrecondition: typeof requiresPrecondition }).requiresPrecondition =
        requiresPrecondition;
      // The stored bundle's specVersion must equal what handleEngineDsl derives
      // from the same payload.modules — otherwise the replay (304) check never
      // matches and every install recompiles.
      return {
        specVersion: computeSpecVersion(payload.modules),
        boundaryCount: dsl.boundaries.length,
        yamlReducerCount: dsl.boundaries.reduce((n, b) => n + b.reducers.length, 0),
        tsReducerCount: sys.tsReducerRegistry.snapshot().length,
      };
    },
  };
}

function makeStateAccessor(sys: BootedSystem): StateAccessor {
  return {
    get(boundary, id): StateBundle | null {
      const entity = sys.graph.get(id);
      if (entity === null || entity === undefined) return null;
      const events = sys.events.byAggregate(id);
      const last = events[events.length - 1];
      // Surface the boundary's declared computed-field names in topological
      // (computed) order so clients can see which keys are formula-derived.
      const inferred = sys.inferredSchemas[boundary];
      const computedFields = inferred ? [...inferred.computedOrder] : [];
      return {
        state: entity,
        meta: {
          version: events.length,
          lastEvent: last ? last.type : null,
          computedFields,
          patchJournal: reproduceAggregateJournal(sys, events),
        },
      };
    },
  };
}

/**
 * Reproduce the cumulative reducer patch journal for an aggregate by replaying
 * its events through the canonical projectEvent path onto a throwaway graph and
 * a throwaway CelEvaluator. Using fresh instances means the live sys.cel's
 * per-instance faker/clock state is never mutated, so concurrent reads stay
 * thread-safe. The validator/schemaRegistry are deliberately omitted: the state
 * was already validated at write time, and re-validating here could throw on a
 * read; we only need the patch provenance. Guarded so a read never 500s — a
 * reproduction failure degrades to an empty journal and is logged.
 */
function reproduceAggregateJournal(
  sys: BootedSystem,
  events: readonly DomainEvent[],
): JournalEntry[] {
  const graph = createStateGraph();
  const cel = createCelEvaluator();
  const journal: JournalEntry[] = [];
  let failedOn: DomainEvent | undefined;
  try {
    for (const event of events) {
      failedOn = event;
      const boundaryConfig = sys.dsl.byBoundaryName[event.boundary];
      if (!boundaryConfig) continue;
      const inferred = sys.inferredSchemas[boundaryConfig.boundary];
      const result = projectEvent({
        event,
        boundary: boundaryConfig,
        graph,
        cel,
        openapi: sys.openapi,
        tsReducerRegistry: sys.tsReducerRegistry,
        ...(inferred && inferred.computedOrder.length > 0
          ? {
              computed: sys.dsl.byBoundaryName[boundaryConfig.boundary]?.state?.computed ?? [],
              computedOrder: inferred.computedOrder,
            }
          : {}),
      });
      journal.push(...result.journal);
    }
  } catch (err) {
    sys.logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        boundary: failedOn?.boundary,
        aggregateId: failedOn?.aggregateId,
        eventId: failedOn?.eventId,
        eventType: failedOn?.type,
      },
      'engine-state: patch-journal reproduction failed; returning empty journal',
    );
    return [];
  }
  return journal;
}

export function mountEngineDslRoutes(app: Express, sys: BootedSystem): void {
  const store = new InMemoryInstallStore();
  const producer = makeInstallProducer(sys);
  const accessor = makeStateAccessor(sys);

  app.post(
    '/_engine/dsl',
    express.json({ strict: false, limit: '50mb' }),
    async (req: Request, res: Response) => {
      const result = await handleEngineDsl(req.body, store, producer);
      switch (result.kind) {
        case 'installed':
          res.status(200).json(result.body);
          return;
        case 'replay':
          res
            .status(304)
            .setHeader('X-Potemkin-Spec-Version', result.specVersion)
            .end();
          return;
        case 'badRequest':
          res.status(400).json(result.body);
          return;
        case 'unavailable':
          res.status(503).setHeader('Retry-After', '1').json({ reason: result.reason });
          return;
      }
    },
  );

  app.get(
    '/_engine/state/:boundary/:id',
    (req: Request, res: Response) => {
      const boundary = String(req.params['boundary']);
      const id = String(req.params['id']);
      const result = handleEngineState(boundary, id, accessor);
      if (result.kind === 'notFound') {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      res.status(200).json(result.body);
    },
  );
}
