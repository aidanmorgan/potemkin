/**
 * Coverage backfill for http/gateway.ts
 *
 * Uncovered lines:
 *  - 158: `throw err` — re-throw non-ContractViolationError from pre-validation catch
 *  - 225: `res.status(400).json(err.toJSON())` — ContractViolationError from UoW
 *  - 228-231: `else if (err instanceof FaultSimulatedError)` from UoW throw
 *  - 232-235: generic `else` branch for unknown error types from UoW
 *
 * Strategy: mock executeUnitOfWork and sys.validator.validateRequest to throw
 * specific error types, then verify the gateway maps them correctly.
 */

import request from 'supertest';
import type { Express } from 'express';
import { createGateway } from '../../../src/http/gateway';
import { bootSystem, type BootedSystem } from '../../../src/engine/boot';
import { loadOpenApi } from '../../../src/contract/loader';
import { resetSystem } from '../../../src/engine/reset';
import {
  ContractViolationError,
  InternalExecutionError,
  FaultSimulatedError,
} from '../../../src/errors';
import { compileDsl } from '../../../src/dsl/parser';

// ── Minimal fixture ───────────────────────────────────────────────────────────

const MINIMAL_OPENAPI = `
openapi: "3.0.3"
info:
  title: Gateway Coverage Test
  version: "1.0.0"
paths:
  /items:
    post:
      operationId: createItem
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Item"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
      required:
        - label
`;

const ITEM_DSL = `
boundary: Item
contract_path: /items
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: ItemCreated
    payload_template:
      id: "command.targetId"
      label: "command.payload.label"
behaviors:
  - name: create-item
    match:
      intent: creation
      condition: "true"
    emit: ItemCreated
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /id, value: "event.payload.id" }
      - { op: replace, path: /label, value: "event.payload.label" }
`;

describe('http/gateway.ts — defensive guard coverage', () => {
  let sys: BootedSystem;
  let app: Express;

  beforeAll(async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'item', yaml: ITEM_DSL }]),
    });
    app = createGateway(sys);
  });

  afterEach(() => {
    if (sys) resetSystem(sys);
    // Restore any spies
    jest.restoreAllMocks();
  });

  // ── Line 158: re-throw non-ContractViolationError from pre-validation ─────────

  describe('line 158 — non-ContractViolationError from validateRequest is rethrown', () => {
    it('non-ContractViolationError from validateRequest propagates to Express error handler (→ 500)', async () => {
      // Spy on validator.validateRequest to throw InternalExecutionError (non-ContractViolationError)
      // The gateway catch block at lines 153-159 only catches ContractViolationError → 400;
      // anything else is rethrown (line 158) → caught by Express error handler → 500
      jest.spyOn(sys.validator, 'validateRequest').mockImplementation(() => {
        throw new InternalExecutionError('Mocked non-contract-violation error from validateRequest');
      });

      const res = await request(app)
        .post('/items')
        .send({ label: 'test' });

      // The rethrown error propagates to Express error handler → 500
      expect(res.status).toBe(500);
    });
  });

  // ── Lines 228-231: FaultSimulatedError thrown from UoW ────────────────────

  describe('lines 228-231 — FaultSimulatedError from UoW execution', () => {
    it('FaultSimulatedError thrown from UoW returns simulated status (lines 228-231)', async () => {
      // Mock executeUnitOfWork to throw FaultSimulatedError
      // FaultSimulatedError is defined in errors.ts; it extends SimError
      // The gateway catches it at lines 228-231 and returns fault.status/body
      const { executeUnitOfWork } = require('../../../src/engine/uow');
      jest.spyOn(require('../../../src/engine/uow'), 'executeUnitOfWork')
        .mockRejectedValueOnce(
          new FaultSimulatedError(503, { error: 'SERVICE_DOWN' }),
        );

      const res = await request(app)
        .post('/items')
        .send({ label: 'test' });

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: 'SERVICE_DOWN' });
    });

    it('FaultSimulatedError with simulatedHeaders sets headers (lines 229-230)', async () => {
      // FaultSimulatedError with simulatedHeaders
      const fault = new FaultSimulatedError(
        429,
        { error: 'RATE_LIMIT' },
        { 'Retry-After': '60', 'X-Fault-Source': 'gateway-test' },
      );

      jest.spyOn(require('../../../src/engine/uow'), 'executeUnitOfWork')
        .mockRejectedValueOnce(fault);

      const res = await request(app)
        .post('/items')
        .send({ label: 'test' });

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('60');
      expect(res.headers['x-fault-source']).toBe('gateway-test');
    });
  });

  // ── Lines 232-235: generic else branch — unknown error type from UoW ────────

  describe('lines 232-235 — generic error from UoW (not a known SimError)', () => {
    it('plain Error thrown from UoW returns 500 INTERNAL (lines 232-235)', async () => {
      // Throw a plain Error (not any SimError subclass) — hits the else branch at lines 232-235
      jest.spyOn(require('../../../src/engine/uow'), 'executeUnitOfWork')
        .mockRejectedValueOnce(new Error('Unexpected plain JavaScript error from UoW'));

      const res = await request(app)
        .post('/items')
        .send({ label: 'test' });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: 'INTERNAL' });
      expect(res.body.message).toContain('Unexpected plain JavaScript error');
    });

    it('non-Error primitive thrown from UoW returns 500 INTERNAL with String(err) message (line 235)', async () => {
      // Throw a string literal (not an Error) → String(err) branch at line 234
      jest.spyOn(require('../../../src/engine/uow'), 'executeUnitOfWork')
        .mockRejectedValueOnce('non-error-string-from-uow');

      const res = await request(app)
        .post('/items')
        .send({ label: 'test' });

      expect(res.status).toBe(500);
      expect(res.body.message).toContain('non-error-string-from-uow');
    });
  });

  // ── Line 225: ContractViolationError from UoW ────────────────────────────────

  describe('line 225 — ContractViolationError from UoW execution', () => {
    it('ContractViolationError from UoW returns 400 (line 225)', async () => {
      // Mock UoW to throw ContractViolationError (response validation failure)
      jest.spyOn(require('../../../src/engine/uow'), 'executeUnitOfWork')
        .mockRejectedValueOnce(
          new ContractViolationError('Response body does not match schema', {
            errors: [{ field: 'id', message: 'required' }] as any,
          }),
        );

      const res = await request(app)
        .post('/items')
        .send({ label: 'test' });

      expect(res.status).toBe(400);
    });
  });

  // ── Line 155: ContractViolationError from validateRequest → 400 CONTRACT_VIOLATION ──

  describe('line 155 — ContractViolationError from validateRequest returns 400', () => {
    it('ContractViolationError from validateRequest returns 400 CONTRACT_VIOLATION (line 155)', async () => {
      // The gateway pre-validation catch block (lines 153-159) specifically handles
      // ContractViolationError → 400 with CONTRACT_VIOLATION error code
      // err.details is defined → details branch of ?? is used
      jest.spyOn(sys.validator, 'validateRequest').mockImplementation(() => {
        throw new ContractViolationError('Request body does not match schema', {
          errors: [{ field: 'label', message: 'required' }] as any,
        });
      });

      const res = await request(app)
        .post('/items')
        .send({ notLabel: 'missing required field' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CONTRACT_VIOLATION');
    });

    it('ContractViolationError without details falls back to err.message (line 155 ?? branch)', async () => {
      // err.details is undefined → err.message branch of ?? is used (covers the ?? fallback)
      jest.spyOn(sys.validator, 'validateRequest').mockImplementation(() => {
        throw new ContractViolationError('No details provided');
        // No second arg → details is undefined → err.details ?? err.message = err.message
      });

      const res = await request(app)
        .post('/items')
        .send({ label: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CONTRACT_VIOLATION');
      expect(res.body.details).toBe('No details provided');
    });
  });

  // ── Lines 149,179: req.body is null/undefined → ?? {} branch ─────────────────

  describe('lines 149,179 — null body in validateRequest call and command payload', () => {
    it('POST with JSON null body (req.body=null ?? {}) is handled correctly (lines 149,179)', async () => {
      // Sending JSON `null` forces req.body = null (express.json strict:false allows it)
      // The ?? {} branch at line 149 fires: null ?? {} = {} (for validateRequest call)
      const res = await request(app)
        .post('/items')
        .set('Content-Type', 'application/json')
        .send('null');

      // Gateway will process the request with {} as the body; contract validator may reject
      expect([400, 201, 422].includes(res.status)).toBe(true);
    });

    it('POST with JSON null body and mocked validation covers line 179 ?? {} in payload', async () => {
      // To reach line 179, validation must pass. Mock validateRequest to not throw.
      // req.body=null → null ?? {} = {} in command.payload (line 179)
      jest.spyOn(sys.validator, 'validateRequest').mockImplementation(() => {
        // Do nothing — validation passes
      });
      // Also mock UoW to return a result so we don't need a real entity
      jest.spyOn(require('../../../src/engine/uow'), 'executeUnitOfWork')
        .mockResolvedValueOnce({
          status: 201,
          body: { id: 'gen-id', label: 'from-null-body' },
          events: [],
          headers: {},
        });

      const res = await request(app)
        .post('/items')
        .set('Content-Type', 'application/json')
        .send('null');

      // Validation was mocked to pass; UoW was mocked to succeed
      expect(res.status).toBe(201);
    });
  });


  // ── Line 250: primaryEvents.length === 0 → fallback to result.events for ETag ───

  describe('line 250 — events with different aggregateId → empty primaryEvents → ETag fallback', () => {
    it('when no events match targetId, ETag falls back to result.events.at(-1) (line 250)', async () => {
      // UoW returns events with an aggregateId different from command.targetId.
      // primaryAggregateId (= command.targetId, a uuidv7) !== null → takes the filter branch.
      // The filter finds zero matching events → primaryEvents.length === 0.
      // → hits line 250: seqForEtag = result.events.at(-1)?.sequenceVersion
      jest.spyOn(sys.validator, 'validateRequest').mockImplementation(() => {
        // pass validation so we reach the UoW call
      });
      jest.spyOn(require('../../../src/engine/uow'), 'executeUnitOfWork')
        .mockResolvedValueOnce({
          status: 201,
          body: { id: 'something', label: 'cascaded' },
          events: [
            {
              // aggregateId does NOT match command.targetId (which is a uuidv7)
              aggregateId: 'completely-different-agg-id',
              sequenceVersion: 7,
              eventId: 'evt-cascade',
              type: 'Cascaded',
              boundary: 'Item',
              payload: {},
              timestamp: '',
              causedBy: 'cmd-cascade',
            },
          ],
          headers: {},
        });

      const res = await request(app)
        .post('/items')
        .send({ label: 'trigger-cascade' });

      expect(res.status).toBe(201);
      // ETag should be set to "7" (RFC 7232 quoted) via the fallback line 250
      expect(res.headers['etag']).toBe('"7"');
    });
  });

});

// ── Separate suite for null-targetId creation (lines 247-250) ────────────────

const NO_IDENTITY_OPENAPI = `
openapi: "3.0.3"
info:
  title: No-Identity Gateway Test
  version: "1.0.0"
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Widget"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Widget"
components:
  schemas:
    Widget:
      type: object
      properties:
        name:
          type: string
      required:
        - name
`;

const NO_IDENTITY_DSL = `
boundary: Widget
contract_path: /widgets
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

describe('http/gateway.ts — null targetId creation (lines 247-250)', () => {
  let sysNoId: BootedSystem;
  let appNoId: Express;

  beforeAll(async () => {
    const openapi = await loadOpenApi(NO_IDENTITY_OPENAPI);
    sysNoId = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'widget', yaml: NO_IDENTITY_DSL }]),
    });
    appNoId = createGateway(sysNoId);
  });

  afterAll(() => {
    if (sysNoId) resetSystem(sysNoId);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creation with null targetId and events uses result.events for ETag (lines 247-250)', async () => {
    // No identity.creation.generate → targetId remains null (line 165-170)
    // isMutating=true, result.events.length > 0, primaryAggregateId === null
    // → hits the else branch at line 249: primaryEvents = result.events
    jest.spyOn(require('../../../src/engine/uow'), 'executeUnitOfWork')
      .mockResolvedValueOnce({
        status: 201,
        body: { name: 'widget-one' },
        events: [
          {
            aggregateId: 'some-agg',
            sequenceVersion: 3,
            eventId: 'e-w1',
            type: 'WidgetCreated',
            boundary: 'Widget',
            payload: {},
            timestamp: '',
            causedBy: 'c1',
          },
        ],
        headers: {},
      });

    const res = await request(appNoId)
      .post('/widgets')
      .send({ name: 'widget-one' });

    // The null-targetId DSL uses fallback_override:true → 200 fallback or 201 from our mock
    expect(res.status).toBe(201);
    // ETag should be set to "3" (RFC 7232 quoted) via the else branch
    expect(res.headers['etag']).toBe('"3"');
  });
});
