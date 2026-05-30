// Express mount for POST /_engine/dsl and GET /_engine/state/:boundary/:id.
// The pure-logic handler in engineDslHandler.ts is wired here against
// production InstallStore / StateAccessor / InstallProducer implementations
// that delegate to the live engine.

import type { Express, Request, Response } from 'express';
import express from 'express';

import type { BootedSystem } from '../engine/boot.js';
import { compileDsl } from '../dsl/parser.js';
import {
  handleEngineDsl,
  handleEngineState,
  type DslInstallStore,
  type InstalledBundle,
  type InstallProducer,
  type StateAccessor,
  type StateBundle,
} from './engineDslHandler.js';

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
      const dsl = await compileDsl(modules);
      // Atomic swap: replace the BootedSystem.dsl reference. The graph is
      // left untouched so projected state survives the swap.
      (sys as { dsl: typeof dsl }).dsl = dsl;
      return {
        specVersion: 'computed-by-handler',
        boundaryCount: dsl.boundaries.length,
        yamlReducerCount: dsl.boundaries.reduce((n, b) => n + b.reducers.length, 0),
        tsReducerCount: 0,
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
      // C4: surface the boundary's declared computed-field names in topological
      // (computed) order so clients can see which keys are formula-derived.
      const inferred = sys.inferredSchemas[boundary];
      const computedFields = inferred ? [...inferred.computedOrder] : [];
      return {
        state: entity,
        meta: {
          version: events.length,
          lastEvent: last ? last.type : null,
          computedFields,
          patchJournal: [],
        },
      };
    },
  };
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
