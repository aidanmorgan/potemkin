/**
 * parallel-requests.integration.test.ts
 *
 * Proves the engine is parallel-safe now that all shared mutable state lives
 * on the BootedSystem instance (per-boot CelEvaluator, per-boot aggregateLocks,
 * per-boot EventStore) rather than module globals.
 *
 * ONE system is booted (createGateway over a single bootSystem) and MANY (>=20)
 * concurrent requests are fired with Promise.all. Three properties are proven:
 *
 *  1. Per-request control headers do NOT bleed across concurrent requests.
 *     Each request carries a DISTINCT X-Potemkin-Clock-Offset and a DISTINCT
 *     X-Potemkin-Seed. The clock offset feeds $now() (captured into the event
 *     payload) and the seed feeds $fake() (also captured). Each response must
 *     reflect ONLY its own request's inputs — verified against a single-threaded
 *     reference run of the identical inputs.
 *
 *  2. Concurrent mutations to the SAME aggregate serialize correctly via
 *     sys.aggregateLocks: N concurrent bumps yield N distinct, contiguous
 *     sequence versions (no lost updates) and a consistent final version.
 *
 *  3. Concurrent requests to DIFFERENT aggregates all succeed independently.
 *
 * The whole concurrent suite is repeated REPEAT times to confirm determinism
 * (no flaky interleaving-dependent bleed).
 */

import http from 'node:http';
import request from 'supertest';
import type { Express } from 'express';
import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';

// ---------------------------------------------------------------------------
// Inline fixture: a Counter boundary.
//   POST  /counters        → create (captures $now() + $fake() into the event)
//   PATCH /counters/{id}   → bump   (monotonic CounterBumped events)
//   GET   /counters/{id}   → read current state
// ---------------------------------------------------------------------------

const OPENAPI = `
openapi: "3.0.3"
info:
  title: Parallel Counter
  version: "1.0.0"
paths:
  /counters:
    post:
      operationId: createCounter
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CounterCreate"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Counter"
  /counters/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getCounter
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Counter"
    patch:
      operationId: bumpCounter
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Bumped
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Counter"
components:
  schemas:
    CounterCreate:
      type: object
      properties:
        label:
          type: string
      required:
        - label
    Counter:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
        count:
          type: integer
        createdAt:
          type: string
        fakeName:
          type: string
      required:
        - id
        - label
        - count
    CounterById:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
        count:
          type: integer
        createdAt:
          type: string
        fakeName:
          type: string
      required:
        - id
        - label
        - count
`;

const COUNTER_DSL = `
boundary: Counter
contract_path: /counters
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: CounterCreated
    payload_template:
      id: "command.targetId"
      label: "command.payload.label"
      createdAt: "$now()"
      fakeName: "$fake('person.firstName')"
  - type: CounterBumped
    payload_template:
      at: "$now()"
behaviors:
  - name: create-counter
    match:
      operationId: createCounter
      condition: "true"
    emit: CounterCreated
reducers:
  - on: CounterCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
      - { op: replace, path: /count, value: "\${0}" }
      - { op: replace, path: /createdAt, value: "\${event.payload.createdAt}" }
      - { op: replace, path: /fakeName, value: "\${event.payload.fakeName}" }
  - on: CounterBumped
    patches:
      - { op: replace, path: /count, value: "\${state.count + 1}" }
`;

const COUNTER_BY_ID_DSL = `
boundary: CounterById
contract_path: /counters/{id}
fallback_override: true
event_catalog:
  - type: CounterBumped
    payload_template:
      at: "$now()"
behaviors:
  - name: bump-counter
    match:
      operationId: bumpCounter
      condition: "true"
    emit: CounterBumped
reducers:
  - on: CounterBumped
    patches:
      - { op: replace, path: /count, value: "\${state.count + 1}" }
`;

const REPEAT = 5;
const CONCURRENCY = 24;

interface CounterEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly sequenceVersion: number;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

async function bootCounterSystem(): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI);
  return bootSystem({
    openapi,
    compiledDsl: await compileDsl([
      { name: 'counter', yaml: COUNTER_DSL },
      { name: 'counterById', yaml: COUNTER_BY_ID_DSL },
    ]),
  });
}

describe('parallel-requests.integration', () => {
  let sys: BootedSystem;
  let app: Express;
  let server: http.Server;
  // A single keep-alive HTTP agent shared by every request keeps the number of
  // OS sockets bounded under heavy concurrency (avoids ECONNRESET / socket
  // hang-up from exhausting the listen backlog with one socket per request).
  let keepAliveAgent: http.Agent;

  // Bind supertest to the running server and pin every request to the shared
  // keep-alive agent so connections are pooled rather than opening a fresh
  // ephemeral server / socket per call.
  const agent = {
    post: (p: string) => request(server).post(p).agent(keepAliveAgent),
    get: (p: string) => request(server).get(p).agent(keepAliveAgent),
    patch: (p: string) => request(server).patch(p).agent(keepAliveAgent),
  };

  beforeAll(async () => {
    sys = await bootCounterSystem();
    app = createGateway(sys);
    keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  beforeEach(() => {
    resetSystem(sys);
  });

  afterAll(async () => {
    resetSystem(sys);
    keepAliveAgent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Create a counter and return its generated id. */
  async function createCounter(label: string): Promise<string> {
    const res = await agent.post('/counters').send({ label });
    expect([200, 201]).toContain(res.status);
    expect(typeof res.body.id).toBe('string');
    return res.body.id as string;
  }

  /** POST /counters with a specific clock offset + seed, returning the created event. */
  async function createWithControls(
    label: string,
    clockOffsetMs: number,
    seed: string,
  ): Promise<{ createdAt: string; fakeName: string; status: number }> {
    const res = await agent
      .post('/counters')
      .set('X-Potemkin-Clock-Offset', String(clockOffsetMs))
      .set('X-Potemkin-Seed', seed)
      .set('X-Potemkin-Include-Events', 'true')
      .send({ label });
    expect([200, 201]).toContain(res.status);
    const ev = (res.body._events as CounterEvent[])[0];
    return {
      createdAt: ev.payload.createdAt as string,
      fakeName: ev.payload.fakeName as string,
      status: res.status,
    };
  }

  // ── Property 1: control-header isolation (clock offset + seed) ────────────

  describe('control headers do not bleed across concurrent requests', () => {
    // Distinct, well-separated offsets so a bled value is unambiguously wrong.
    const inputs = Array.from({ length: CONCURRENCY }, (_, i) => ({
      label: `c-${i}`,
      // 1h, 2h, 3h ... apart — gaps far exceed any realistic wall-clock drift.
      clockOffsetMs: (i + 1) * 3_600_000,
      seed: `seed-${i}`,
    }));

    for (let run = 0; run < REPEAT; run++) {
      it(`run ${run}: each response reflects ONLY its own clock-offset and seed`, async () => {
        // Reference: run the identical inputs strictly sequentially. Because the
        // CelEvaluator's faker RNG is per-instance and the clock offset is
        // restored after every request, the sequential run is the ground truth
        // for "what this seed/offset should produce".
        const reference: Array<{ createdAt: string; fakeName: string }> = [];
        for (const inp of inputs) {
          const r = await createWithControls(inp.label, inp.clockOffsetMs, inp.seed);
          reference.push({ createdAt: r.createdAt, fakeName: r.fakeName });
        }
        resetSystem(sys);

        // Concurrent: fire all inputs at once through the one shared system.
        const concNowStart = Date.now();
        const results = await Promise.all(
          inputs.map((inp) =>
            createWithControls(inp.label, inp.clockOffsetMs, inp.seed),
          ),
        );
        const concNowEnd = Date.now();

        for (let i = 0; i < inputs.length; i++) {
          const inp = inputs[i]!;
          const got = results[i]!;

          // (a) Clock offset isolation: the captured $now() must equal
          //     (wall clock at emit) + this request's own offset — never a
          //     neighbour's offset. We assert it lands in this request's
          //     expected window.
          const gotMs = new Date(got.createdAt).getTime();
          const lo = concNowStart + inp.clockOffsetMs - 5_000;
          const hi = concNowEnd + inp.clockOffsetMs + 5_000;
          expect(gotMs).toBeGreaterThanOrEqual(lo);
          expect(gotMs).toBeLessThanOrEqual(hi);

          // No other request's offset could place a timestamp in this window:
          // offsets are >=1h apart and the window is +/-5s, so any neighbour's
          // offset is excluded by construction (proves no offset bleed).
          for (let j = 0; j < inputs.length; j++) {
            if (j === i) continue;
            const otherMs = concNowStart + inputs[j]!.clockOffsetMs;
            expect(Math.abs(gotMs - otherMs)).toBeGreaterThan(60_000);
          }

          // (b) Seed isolation: the seeded $fake() value must match exactly
          //     what the same seed produced in the sequential reference run.
          expect(got.fakeName).toBe(reference[i]!.fakeName);
        }
      });
    }
  });

  // ── Property 2: same-aggregate mutations serialize (no lost updates) ──────

  describe('concurrent mutations to the same aggregate serialize via aggregateLocks', () => {
    for (let run = 0; run < REPEAT; run++) {
      it(`run ${run}: ${CONCURRENCY} concurrent bumps yield contiguous unique sequence versions`, async () => {
        const id = await createCounter('shared');
        const seqAfterCreate = sys.events.currentSequenceVersion(id);

        // Fire CONCURRENCY bumps at the SAME aggregate concurrently. No If-Match
        // header → no optimistic-concurrency rejection; the aggregate lock must
        // serialize them so each gets a fresh sequence version.
        const responses = await Promise.all(
          Array.from({ length: CONCURRENCY }, () =>
            agent.patch(`/counters/${id}`).send({}),
          ),
        );

        for (const res of responses) {
          expect(res.status).toBe(200);
        }

        // Every bump committed exactly one event; the store holds N new events.
        const bumpEvents = sys.events
          .byAggregate(id)
          .filter((e) => e.type === 'CounterBumped');
        expect(bumpEvents.length).toBe(CONCURRENCY);

        // Sequence versions are unique and contiguous — proof of no lost update
        // and no double-assignment under the shared lock.
        const seqs = bumpEvents.map((e) => e.sequenceVersion).sort((a, b) => a - b);
        const uniqueSeqs = new Set(seqs);
        expect(uniqueSeqs.size).toBe(CONCURRENCY);
        const expected = Array.from(
          { length: CONCURRENCY },
          (_, i) => seqAfterCreate + i + 1,
        );
        expect(seqs).toEqual(expected);

        // Final aggregate version is exactly create + CONCURRENCY bumps.
        expect(sys.events.currentSequenceVersion(id)).toBe(
          seqAfterCreate + CONCURRENCY,
        );

        // The reduced state's count reflects every bump (no lost increments).
        const read = await agent.get(`/counters/${id}`);
        expect(read.status).toBe(200);
        expect(read.body.count).toBe(CONCURRENCY);
      });
    }
  });

  // ── Property 3: different aggregates all succeed independently ────────────

  describe('concurrent requests to different aggregates all succeed independently', () => {
    for (let run = 0; run < REPEAT; run++) {
      it(`run ${run}: ${CONCURRENCY} distinct counters each created and bumped`, async () => {
        // Create CONCURRENCY distinct counters concurrently.
        const ids = await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, i) =>
            createCounter(`indep-${i}`),
          ),
        );
        expect(new Set(ids).size).toBe(CONCURRENCY); // all distinct ids

        // Bump each distinct counter once, concurrently.
        const bumpResults = await Promise.all(
          ids.map((id) => agent.patch(`/counters/${id}`).send({})),
        );
        for (const res of bumpResults) {
          expect(res.status).toBe(200);
        }

        // Each aggregate has exactly one CounterBumped and a count of 1 —
        // none stole or lost another aggregate's event.
        for (const id of ids) {
          const bumps = sys.events
            .byAggregate(id)
            .filter((e) => e.type === 'CounterBumped');
          expect(bumps.length).toBe(1);
          const read = await agent.get(`/counters/${id}`);
          expect(read.status).toBe(200);
          expect(read.body.count).toBe(1);
          expect(read.body.id).toBe(id);
        }
      });
    }
  });
});
