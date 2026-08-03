import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import request from "supertest";
import { bootYamlRuntimeFromConfig } from "../../../src/parser/files.js";
import {
  collectExportExamples,
  exportExamples,
  resolveExamplePaths,
} from "../../../src/cli/export-examples.js";
import { loadEngineFixture } from "../../fixtures/index.js";
import {
  createDefaultRuntimeHost,
  createDeterministicRuntimeHost,
} from "../../../src/runtime/host.js";
import { createRuntimeGateway } from "../../../src/http/runtimeGateway.js";

async function captureStripeTransitionExport(): Promise<{
  readonly serialised: string;
  readonly body: Record<string, unknown>;
}> {
  const fixture = await loadEngineFixture("stripe");
  const system = await bootYamlRuntimeFromConfig({
    ...fixture,
    host: createDeterministicRuntimeHost({
      epochMs: 0,
      randomSeed: "potemkin-export-transition",
      uuidSeedIndex: 0,
    }),
  });
  try {
    const app = createRuntimeGateway(system);
    const created = await request(app)
      .post("/v1/payment_intents")
      .type("form")
      .send({ amount: 2_000, currency: "usd", payment_method: "pm_card_visa" });
    expect(created.status).toBe(200);

    const paymentIntent = created.body as { id: string };
    const confirmed = await request(app)
      .post(`/v1/payment_intents/${paymentIntent.id}/confirm`)
      .type("form")
      .send({});
    expect(confirmed.status).toBe(200);
    const body = confirmed.body as Record<string, unknown>;
    return {
      serialised: JSON.stringify({
        "http-request": {
          method: "POST",
          path: `/v1/payment_intents/${paymentIntent.id}/confirm`,
        },
        "http-response": { status: confirmed.status, body },
      }),
      body,
    };
  } finally {
    await system.dispose();
  }
}

describe("Specmatic externalized example exporter", () => {
  it("collects seeded by-id snapshots and bare collection snapshots from the live engine", async () => {
    const fixture = await loadEngineFixture("crm");
    const system = await bootYamlRuntimeFromConfig({
      ...fixture,
      host: createDefaultRuntimeHost(),
    });
    const warnings = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const examples = await collectExportExamples(system);
      expect(examples.some((example) => example.name.startsWith("Lead__GET__"))).toBe(true);
      const collection = examples.find((example) => example.name === "Lead__collection");
      expect(collection).toBeDefined();
      expect(collection?.httpResponse.headers["content-type"]).toBe(
        "application/json; charset=utf-8",
      );
      expect(collection?.httpResponse.headers["x-specmatic-result"]).toBeUndefined();
      expect(Array.isArray(collection?.httpResponse.body)).toBe(true);
      expect(examples.every((example) => example.httpRequest.path.includes("{") === false)).toBe(
        true,
      );
      expect(
        new Set(
          examples.map((example) => `${example.httpRequest.method} ${example.httpRequest.path}`),
        ).size,
      ).toBe(examples.length);
      const won = examples.find((example) => example.name.startsWith("Opportunity__WON__GET__"));
      const lost = examples.find((example) => example.name.startsWith("Opportunity__LOST__GET__"));
      const saga = examples.find((example) =>
        example.name.startsWith("Opportunity__LeadConversionSaga__GET__"),
      );
      expect(won?.httpResponse.body).toMatchObject({ stage: "WON" });
      expect(lost?.httpResponse.body).toMatchObject({ stage: "LOST" });
      expect(saga?.httpResponse.body).toMatchObject({ stage: "PROPOSED" });
      expect(
        examples.some((example) => example.name.startsWith("Campaign__COMPLETED__GET__")),
      ).toBe(true);
      expect(warnings.mock.calls.flat().join(" ")).not.toContain("advanceOpportunity");
      expect(examples.some((example) => example.name.startsWith("getLead__404__"))).toBe(true);
      expect(examples.some((example) => example.name.startsWith("qualifyLead__422__"))).toBe(true);
      expect(examples.some((example) => example.name.startsWith("advanceOpportunity__422__"))).toBe(
        true,
      );
      expect(examples.some((example) => example.name.startsWith("createAgent__404__"))).toBe(false);
      expect(
        examples
          .filter((example) => example.httpResponse.status === 422)
          .every((example) => example.httpRequest.body !== undefined),
      ).toBe(true);
    } finally {
      warnings.mockRestore();
      await system.dispose();
    }
  });

  it("hard-fails with the boundary and path when a generated body is invalid", async () => {
    const fixture = await loadEngineFixture("crm");
    const system = await bootYamlRuntimeFromConfig({
      ...fixture,
      host: createDefaultRuntimeHost(),
    });
    const originalProgram = system.program;
    try {
      system.program = {
        ...originalProgram,
        dependencies: {
          ...originalProgram.dependencies,
          contract: {
            ...originalProgram.dependencies.contract,
            validateResponse: () => {
              throw new Error("invalid exported body");
            },
          },
        },
      };
      const collection = collectExportExamples(system);
      await expect(collection).rejects.toMatchObject({
        name: "ExportError",
        code: "EXPORT_INVALID",
      });
      await expect(collection).rejects.toThrow("Agent /agents/");
    } finally {
      system.program = originalProgram;
      await system.dispose();
    }
  });

  it("resolves the conventional OpenAPI examples directory", () => {
    const resolved = resolveExamplePaths("examples/crm");
    expect(resolved.contractPath).toMatch(/examples\/crm\/openapi\/.*\.yaml$/);
    expect(resolved.defaultOutputDir).toMatch(/_examples$/);
  });

  it("writes a deterministic corpus and detects drift without mutating check output", async () => {
    const resolved = resolveExamplePaths("examples/crm");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "potemkin-export-test-"));
    const secondOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "potemkin-export-test-"));
    try {
      const first = await exportExamples({ ...resolved, outputDir });
      expect(first.files).toHaveLength(57);
      expect(first.changed).toEqual([]);

      const second = await exportExamples({ ...resolved, outputDir: secondOutputDir });
      expect(second.files).toEqual(first.files);
      expect(
        first.files.map((file) => fs.readFileSync(path.join(outputDir, file), "utf8")),
      ).toEqual(
        second.files.map((file) => fs.readFileSync(path.join(secondOutputDir, file), "utf8")),
      );

      const checked = await exportExamples({ ...resolved, outputDir, check: true });
      expect(checked.changed).toEqual([]);

      const firstFile = path.join(outputDir, first.files[0]!);
      const before = fs.readFileSync(firstFile, "utf8");
      fs.writeFileSync(firstFile, `${before}\n`, "utf8");
      const drift = await exportExamples({ ...resolved, outputDir, check: true });
      expect(drift.changed).toContain(first.files[0]);
      expect(fs.readFileSync(firstFile, "utf8")).toBe(`${before}\n`);

      fs.writeFileSync(firstFile, before, "utf8");
      fs.rmSync(firstFile);
      const removed = await exportExamples({ ...resolved, outputDir, check: true });
      expect(removed.changed).toContain(first.files[0]);

      fs.writeFileSync(path.join(outputDir, "orphaned-example.json"), "{}\n", "utf8");
      const added = await exportExamples({ ...resolved, outputDir, check: true });
      expect(added.changed).toContain("orphaned-example.json");
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.rmSync(secondOutputDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("reproduces a transition body that mints an id inside the engine", async () => {
    const warnings = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let first!: Awaited<ReturnType<typeof captureStripeTransitionExport>>;
    let second!: Awaited<ReturnType<typeof captureStripeTransitionExport>>;
    try {
      first = await captureStripeTransitionExport();
      second = await captureStripeTransitionExport();
    } finally {
      warnings.mockRestore();
    }

    expect(second.serialised).toBe(first.serialised);
    expect(first.body["id"]).toEqual(expect.stringMatching(/^pi_/));
    expect(first.body["latest_charge"]).toEqual(expect.stringMatching(/^ch_/));
    expect(first.body["client_secret"]).toEqual(
      expect.stringMatching(new RegExp(`^${first.body["id"] as string}_secret_.+`)),
    );
    expect(first.body["latest_charge"]).not.toBe(first.body["id"]);
  }, 60_000);

  it("exports distinct contract-shaped Stripe states and transition side effects", async () => {
    const fixture = await loadEngineFixture("stripe");
    const system = await bootYamlRuntimeFromConfig({
      ...fixture,
      host: createDeterministicRuntimeHost({
        epochMs: 0,
        randomSeed: "potemkin-export-transition-states",
        uuidSeedIndex: 0,
      }),
    });
    const warnings = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const examples = await collectExportExamples(system);
      const paymentIntents = examples.filter((example) =>
        example.name.startsWith("payment_intent__v1_payment_intents__"),
      );
      expect(paymentIntents.map((example) => example.name)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("requires_confirmation"),
          expect.stringContaining("requires_payment_method"),
          expect.stringContaining("requires_capture"),
          expect.stringContaining("succeeded"),
          expect.stringContaining("canceled"),
        ]),
      );
      expect(new Set(paymentIntents.map((example) => example.httpRequest.path)).size).toBe(
        paymentIntents.length,
      );
      expect(
        examples.filter(
          (example) =>
            example.name.startsWith("charge__v1_charges__") && example.name.includes("__GET__"),
        ),
      ).toHaveLength(2);
      expect(
        examples
          .filter(
            (example) =>
              example.name.startsWith("charge__v1_charges__") && example.name.includes("__GET__"),
          )
          .every((example) => /\/ch_[^/]+$/.test(example.httpRequest.path)),
      ).toBe(true);
    } finally {
      warnings.mockRestore();
      await system.dispose();
    }
  }, 120_000);
});
