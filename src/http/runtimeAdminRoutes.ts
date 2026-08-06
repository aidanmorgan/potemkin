import type { Express, NextFunction, Request, Response } from 'express';
import type { RuntimeFault } from '../model/runtime.js';
import type { RuntimeSystem } from '../runtime/system.js';
import { AggregateId, faultId } from '../domain/references.js';
import { isRecord } from '../contracts/value.js';
import { parseRuntimeFaultWire } from './runtimeFaultWire.js';
import type { RuntimeGatewayExtensions } from './runtimeGatewayTypes.js';

function adminGuard(
  request: Request,
  response: Response,
  next: NextFunction,
  token: string | undefined,
): void {
  if (token === undefined || request.headers.authorization === `Bearer ${token}`) next();
  else response.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin token required' });
}

function runtimeFaultWire(rule: RuntimeFault): Readonly<Record<string, unknown>> {
  const match: Record<string, unknown> = {
    ...(rule.headers === undefined ? {} : { headers: rule.headers }),
    ...(rule.selectors?.signal === undefined ? {} : { signal: rule.selectors.signal }),
    ...(rule.selectors?.forceResponse === undefined
      ? {}
      : { force_response: rule.selectors.forceResponse }),
    ...(rule.selectors?.scenario === undefined ? {} : { scenario: rule.selectors.scenario }),
    ...(rule.selectors?.featureFlag === undefined
      ? {}
      : { feature_flag: rule.selectors.featureFlag }),
    ...(rule.selectors?.errorClass === undefined ? {} : { error_class: rule.selectors.errorClass }),
  };
  return {
    name: rule.name,
    ...(Object.keys(match).length === 0 ? {} : { match }),
    response: {
      status: rule.response.status,
      ...(rule.response.body === undefined ? {} : { body: rule.response.body }),
      ...(rule.response.headers === undefined ? {} : { headers: rule.response.headers }),
      ...(rule.delayMs === undefined ? {} : { delay_ms: rule.delayMs }),
    },
  };
}

export function registerRuntimeAdminRoutes(
  app: Express,
  system: RuntimeSystem,
  extensions: RuntimeGatewayExtensions,
): void {
  app.use('/_admin', (request, response, next) =>
    adminGuard(request, response, next, extensions.adminToken),
  );
  app.post('/_admin/force-reload', async (_request, response, next) => {
    if (extensions.reloadConfiguration === undefined) {
      response.status(404).json({
        code: 'CONFIG_RELOAD_UNAVAILABLE',
        message: 'Configuration reload is unavailable for this runtime',
      });
      return;
    }
    try {
      response.status(200).json(await extensions.reloadConfiguration());
    } catch (error) {
      next(error);
    }
  });
  app.post('/_admin/reset', async (_request, response, next) => {
    try {
      await system.engine.reset();
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  app.post('/_admin/faults', (request, response, next) => {
    try {
      const parse =
        extensions.parseFaultRegistration ??
        ((value: unknown) => parseRuntimeFaultWire(value, system.clock.nowMs()));
      const input = parse(request.body);
      const id = system.faults.add(input.rule, input.ttlMs);
      const entry = system.faults.list().find((candidate) => candidate.id === id);
      const ttlSeconds =
        entry?.expiresAt === undefined ? undefined : (entry.expiresAt - entry.createdAt) / 1_000;
      response.status(201).json({
        id: String(id),
        name: input.rule.name,
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/_admin/faults', (_request, response) => {
    response.status(200).json(
      system.faults.list().map((entry) => ({
        id: String(entry.id),
        rule: runtimeFaultWire(entry.rule),
      })),
    );
  });
  app.delete('/_admin/faults/:id', (request, response) => {
    const id = faultId(request.params.id);
    if (!system.faults.remove(id)) {
      response.status(404).json({ error: 'NOT_FOUND', message: `No fault rule with id "${id}"` });
      return;
    }
    response.status(204).end();
  });
  app.post('/_admin/clock/advance', (request, response, next) => {
    try {
      const raw = isRecord(request.body) ? request.body['ms'] : undefined;
      const milliseconds = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(milliseconds)) {
        response
          .status(400)
          .json({ code: 'INVALID_CLOCK_ADVANCE', message: 'ms must be a finite number' });
        return;
      }
      response.status(200).json({ offsetMs: system.clock.advance(milliseconds) });
    } catch (error) {
      next(error);
    }
  });
  app.post('/_admin/clock/reset', (_request, response, next) => {
    try {
      system.clock.reset();
      response.status(200).json({ offsetMs: system.clock.offsetMs() });
    } catch (error) {
      next(error);
    }
  });
  app.get('/_admin/health', (_request, response) => {
    const snapshot = system.engine.snapshot();
    response.status(200).json({
      status: 'ok',
      ready: true,
      version: extensions.version ?? '0.1.0',
      uptime: process.uptime(),
      entityCount: snapshot.state.length,
      eventCount: snapshot.events.length,
    });
  });
  app.get('/_admin/state', (request, response) => {
    const boundary =
      typeof request.query.boundary === 'string' ? request.query.boundary : undefined;
    if (boundary !== undefined && !system.program.byBoundaryName.has(boundary)) {
      response
        .status(404)
        .json({ code: 'BOUNDARY_NOT_FOUND', message: `Unknown boundary '${boundary}'` });
      return;
    }
    const snapshot = system.engine.snapshot();
    const idsForBoundary =
      boundary === undefined
        ? undefined
        : new Set(
            snapshot.events
              .filter((event) => event.boundary === boundary)
              .map((event) => event.aggregateId),
          );
    const entities = Object.fromEntries(
      snapshot.state.filter(
        ([id]) => idsForBoundary === undefined || idsForBoundary.has(AggregateId.parse(id)),
      ),
    );
    response.status(200).json({ entities });
  });
  app.get('/_admin/derived/:name', (request, response) => {
    const name = request.params.name;
    const declared =
      system.program.policies.derivedProjections?.some((projection) => projection.name === name) ??
      false;
    if (!declared) {
      response
        .status(404)
        .json({ error: 'NOT_FOUND', message: `No derived projection named "${name}"` });
      return;
    }
    const entries = system.engine.snapshot().projections[name] ?? [];
    response.status(200).json(Object.fromEntries(entries));
  });
  app.get('/_admin/events', (request, response) => {
    const query = request.query;
    let events = [...system.engine.snapshot().events];
    if (typeof query.aggregateId === 'string')
      events = events.filter((event) => event.aggregateId === query.aggregateId);
    if (typeof query.type === 'string')
      events = events.filter((event) => event.type === query.type);
    if (query.count === 'true') {
      response.status(200).json({ count: events.length });
      return;
    }
    const offset = typeof query.offset === 'string' ? Math.max(0, Number(query.offset) || 0) : 0;
    const limit =
      typeof query.limit === 'string' ? Math.max(0, Number(query.limit) || 0) : undefined;
    response.status(200).json({
      events: limit === undefined ? events.slice(offset) : events.slice(offset, offset + limit),
    });
  });
  app.get('/_admin/model', (_request, response) =>
    response.status(200).json(
      system.transitionModel ?? {
        schemaVersion: 1,
        machines: [],
      },
    ),
  );
}
