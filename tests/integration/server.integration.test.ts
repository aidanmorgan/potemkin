import * as path from "node:path";
import { startServer } from "../../src/cli/server.js";
import type { JsonValue } from "../../src/types.js";
import type { RuntimeTransportObservation } from "../../src/model/runtime.js";
import { getFreePort } from "../../src/conformance/portAllocator.js";

const FIXTURE_ROOT = path.resolve(process.cwd(), "tests/fixtures/configured-stack");
const CRM_CONFIG = path.resolve(process.cwd(), "examples/crm/potemkin.yml");

const MODES = [
  {
    name: "YAML",
    configPath: path.join(FIXTURE_ROOT, "potemkin-yaml.yml"),
    requestPath: "/things",
    source: "yaml",
  },
  {
    name: "TypeScript",
    configPath: path.join(FIXTURE_ROOT, "potemkin-typescript.yml"),
    requestPath: "/widgets",
    source: "typescript",
  },
] as const;

const BULK_MODES = [
  {
    name: "YAML",
    configPath: path.resolve(process.cwd(), "tests/fixtures/observability/potemkin-yaml.yml"),
    source: "yaml",
  },
  {
    name: "TypeScript",
    configPath: path.resolve(process.cwd(), "tests/fixtures/observability/potemkin-typescript.yml"),
    source: "typescript",
  },
] as const;

function redactSecrets(
  _direction: "request" | "response",
  body: JsonValue | null,
): JsonValue | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, key === "secret" ? "[REDACTED]" : value]),
  );
}

describe("Potemkin production server observability wiring", () => {
  it.each(MODES)(
    "$name shapes an in-contract unimplemented boundary response",
    async (mode) => {
      const server = await startServer({
        configPath: mode.configPath,
        port: await getFreePort(),
        host: "127.0.0.1",
        tracing: { enabled: false },
      });

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/unimplemented`);
        expect(response.status).toBe(501);
        await expect(response.json()).resolves.toEqual({
          error: "BOUNDARY_NOT_IMPLEMENTED",
          message: "No runtime boundary for /unimplemented",
        });
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  it("exposes an idempotent, read-only transition model through the admin surface", async () => {
    const server = await startServer({
      configPath: CRM_CONFIG,
      port: await getFreePort(),
      host: "127.0.0.1",
      tracing: { enabled: false },
    });

    try {
      const first = await fetch(`http://127.0.0.1:${server.port}/_admin/model`);
      const second = await fetch(`http://127.0.0.1:${server.port}/_admin/model`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstModel = (await first.json()) as {
        schemaVersion: number;
        machines: readonly { aggregate: string; controlField: string }[];
      };
      expect(await second.json()).toEqual(firstModel);
      expect(firstModel.schemaVersion).toBe(1);
      expect(firstModel.machines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ aggregate: "Lead", controlField: "status" }),
          expect.objectContaining({ aggregate: "Agent", controlField: "currentStatus" }),
        ]),
      );
    } finally {
      await server.close();
    }
  }, 120_000);

  it.each(MODES)(
    "$name captures the final direct HTTP exchange with injected redaction and byte limits",
    async (mode) => {
      const observations: RuntimeTransportObservation[] = [];
      const server = await startServer({
        configPath: mode.configPath,
        port: await getFreePort(),
        host: "127.0.0.1",
        tracing: { enabled: false },
        observability: {
          observeTransportRequestResponse: (observation) => {
            observations.push(observation);
          },
          requestResponseCapture: { maxBytes: 64, redact: redactSecrets },
        },
      });

      try {
        const traceId = `direct-${mode.name}`;
        const response = await fetch(`http://127.0.0.1:${server.port}${mode.requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-potemkin-trace-id": traceId,
          },
          body: JSON.stringify({ name: "production-server", secret: "do-not-export" }),
        });

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toMatchObject({
          name: "production-server",
          source: mode.source,
        });
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
          request: {
            method: "POST",
            path: mode.requestPath,
            body: {
              captured: true,
              value: { name: "production-server", secret: "[REDACTED]" },
              truncated: false,
            },
          },
          response: {
            status: 201,
            body: { captured: true, truncated: true },
          },
          correlation: { traceId },
        });
        expect(JSON.stringify(observations[0])).not.toContain("do-not-export");
      } finally {
        await server.close();
      }
    },
  );

  it.each(MODES)("$name observes direct validation and admin responses", async (mode) => {
    const observations: RuntimeTransportObservation[] = [];
    const server = await startServer({
      configPath: mode.configPath,
      port: await getFreePort(),
      host: "127.0.0.1",
      tracing: { enabled: false },
      observability: {
        observeTransportRequestResponse: (observation) => {
          observations.push(observation);
        },
        requestResponseCapture: { maxBytes: 4_096 },
      },
    });

    try {
      const invalid = await fetch(`http://127.0.0.1:${server.port}${mode.requestPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-potemkin-trace-id": `invalid-${mode.name}`,
        },
        body: JSON.stringify({}),
      });
      expect(invalid.status).toBe(400);
      await invalid.arrayBuffer();

      const chaos = await fetch(`http://127.0.0.1:${server.port}${mode.requestPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-potemkin-trace-id": `chaos-${mode.name}`,
          "x-potemkin-force-status": "503",
        },
        body: JSON.stringify({ name: "chaos" }),
      });
      expect(chaos.status).toBe(503);
      await chaos.arrayBuffer();

      const health = await fetch(`http://127.0.0.1:${server.port}/_admin/health`, {
        headers: { "x-potemkin-trace-id": `admin-${mode.name}` },
      });
      expect(health.status).toBe(200);
      await health.arrayBuffer();

      expect(observations).toHaveLength(3);
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            request: expect.objectContaining({ path: mode.requestPath }),
            response: expect.objectContaining({ status: 400 }),
            correlation: expect.objectContaining({ traceId: `invalid-${mode.name}` }),
          }),
          expect.objectContaining({
            request: expect.objectContaining({ path: mode.requestPath }),
            response: expect.objectContaining({ status: 503 }),
            correlation: expect.objectContaining({ traceId: `chaos-${mode.name}` }),
          }),
          expect.objectContaining({
            request: expect.objectContaining({ path: "/_admin/health" }),
            response: expect.objectContaining({ status: 200 }),
            correlation: expect.objectContaining({ traceId: `admin-${mode.name}` }),
          }),
        ]),
      );
    } finally {
      await server.close();
    }
  });

  it.each(BULK_MODES)(
    "$name observes direct transactional bulk success and rollback",
    async (mode) => {
      const observations: RuntimeTransportObservation[] = [];
      const server = await startServer({
        configPath: mode.configPath,
        port: await getFreePort(),
        host: "127.0.0.1",
        tracing: { enabled: false },
        observability: {
          observeTransportRequestResponse: (observation) => {
            observations.push(observation);
          },
          requestResponseCapture: { maxBytes: 4_096 },
        },
      });

      try {
        const successfulBody = [
          { id: `${mode.name.toLowerCase()}-one`, name: "one" },
          { id: `${mode.name.toLowerCase()}-two`, name: "two" },
        ];
        const success = await fetch(`http://127.0.0.1:${server.port}/records/bulk`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-potemkin-trace-id": `bulk-success-${mode.name}`,
            "x-potemkin-bulk-transactional": "true",
          },
          body: JSON.stringify(successfulBody),
        });
        expect(success.status).toBe(201);
        await expect(success.json()).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ source: mode.source })]),
        );
        const successObservation = observations.find(
          (observation) => observation.correlation.traceId === `bulk-success-${mode.name}`,
        );
        expect(successObservation).toMatchObject({
          request: { body: { value: successfulBody } },
          response: { status: 201 },
        });

        const duplicateId = `${mode.name.toLowerCase()}-duplicate`;
        const rollback = await fetch(`http://127.0.0.1:${server.port}/records/bulk`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-potemkin-trace-id": `bulk-rollback-${mode.name}`,
            "x-potemkin-bulk-transactional": "true",
          },
          body: JSON.stringify([
            { id: duplicateId, name: "first" },
            { id: duplicateId, name: "duplicate" },
          ]),
        });
        expect(rollback.status).toBe(409);
        await rollback.arrayBuffer();
        expect(observations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              response: expect.objectContaining({ status: 409 }),
              correlation: expect.objectContaining({ traceId: `bulk-rollback-${mode.name}` }),
            }),
          ]),
        );
      } finally {
        await server.close();
      }
    },
  );
});
