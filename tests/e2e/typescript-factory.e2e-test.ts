/**
 * configured TypeScript factory behaviour through the real Specmatic path.
 *
 * The CRM fixture is configured through its single potemkin.yml file. The
 * request goes to Specmatic, through the Potemkin plugin, and into the engine.
 */

import { startE2eApp } from "./_harness/e2e-test-app";
import type { E2eApp } from "./_harness/e2e-test-app";
import { requestThroughSpecmatic } from "./_harness/crm-e2e-helpers";

async function createLead(
  stubUrl: string,
  source: string,
  suffix: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await requestThroughSpecmatic(stubUrl, "POST", "/leads", {
    companyName: `Score Test Corp ${suffix}`,
    contactName: `Score User ${suffix}`,
    phone: `+61 2 9200 00${suffix}`,
    email: `score${suffix}@test.com`,
    source,
  });
  return { ...response, body: response.body as Record<string, unknown> };
}

describe("configured factory behaviour through Specmatic", () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it("preserves the configured CRM score behaviour", async () => {
    const result = await createLead(app.stubUrl, "REFERRAL", "01");
    expect([200, 201]).toContain(result.status);
    expect(result.body["score"]).toBe(80);
  }, 60_000);

  it("returns the expected score for another source", async () => {
    const result = await createLead(app.stubUrl, "WEBSITE", "02");
    expect([200, 201]).toContain(result.status);
    expect(result.body["score"]).toBe(50);
  }, 60_000);

  it("returns score as an integer", async () => {
    const result = await createLead(app.stubUrl, "COLD_LIST", "03");
    expect([200, 201]).toContain(result.status);
    expect(typeof result.body["score"]).toBe("number");
    expect(Number.isInteger(result.body["score"])).toBe(true);
  }, 60_000);
});
