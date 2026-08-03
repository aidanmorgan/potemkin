/**
 * Fixture hot-reload: after engine restart, the force-reload admin operation
 * makes the plugin re-fetch fixtures with a new ETag and replace old registrations.
 *
 * Verifies:
 *  1. Before restart, fixtures are registered.
 *  2. The configuration is explicitly force-reloaded.
 *  3. The plugin receives /ready and completes a fixture refresh.
 *  4. Fixtures are available again after re-registration.
 */

import { startE2eApp } from "./_harness/e2e-test-app";
import type { E2eApp } from "./_harness/e2e-test-app";
import { requestThroughSpecmatic } from "./_harness/crm-e2e-helpers";

async function getFixtures(engineUrl: string): Promise<{ fixtures: unknown[]; checksum: string }> {
  const res = await fetch(`${engineUrl}/_engine/fixtures`);
  return res.json() as Promise<{ fixtures: unknown[]; checksum: string }>;
}

describe("Fixture hot-reload: re-fetches after configuration reload", () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown().catch(() => {
      /* ignore */
    });
  }, 30_000);

  it("fixtures are registered before reload", async () => {
    const { fixtures } = await getFixtures(app.engineUrl);
    expect(fixtures.length).toBeGreaterThan(0);
  }, 60_000);

  it("after configuration reload, fixtures are available again", async () => {
    // Record initial fixture checksum
    const before = await getFixtures(app.engineUrl);
    expect(before.fixtures.length).toBeGreaterThan(0);

    const createdId = `hot-reload-${Date.now()}`;
    const created = await requestThroughSpecmatic(app.stubUrl, "POST", "/leads", {
      companyName: "Reloaded state",
      contactName: "Reload test",
      phone: "+61 2 9000 0000",
      email: `${createdId}@example.test`,
      source: "WEBSITE",
    });
    expect([200, 201]).toContain(created.status);
    const createdBody = created.body as { id?: unknown };
    expect(createdBody.id).toBeDefined();
    const beforeReload = await requestThroughSpecmatic(
      app.stubUrl,
      "GET",
      `/leads/${String(createdBody.id)}`,
    );
    expect(beforeReload.status).toBe(200);

    // Reload the configured runtime (this also sends /ready to the plugin).
    const reload = await fetch(`${app.engineUrl}/_admin/force-reload`, { method: "POST" });
    expect(reload.status).toBe(200);
    await expect(reload.json()).resolves.toEqual(expect.objectContaining({ reloaded: true }));

    // The force-reload endpoint completes only after the runtime has reloaded
    // and notified the plugin, so fixture registration is asserted immediately.
    const after = await getFixtures(app.engineUrl);
    expect(after.fixtures.length).toBeGreaterThanOrEqual(before.fixtures.length);

    // The business request is still sent through Specmatic. A successful
    // engine-specific 404 proves the old mutable entity was not retained and
    // prevents a generated 2xx response from being mistaken for forwarding.
    const afterReload = await requestThroughSpecmatic(
      app.stubUrl,
      "GET",
      `/leads/${String(createdBody.id)}`,
    );
    expect(afterReload.status).toBe(404);
    expect(afterReload.body).toEqual(expect.objectContaining({ error: "ENTITY_ABSENCE" }));
  }, 60_000);

  it("refreshes fixtures after the Node engine restarts while the JVM remains running", async () => {
    const jvmPid = app.specmatic.process.pid;
    const created = await requestThroughSpecmatic(app.stubUrl, "POST", "/leads", {
      companyName: "Restarted state",
      contactName: "Restart test",
      phone: "+61 2 9000 0001",
      email: `restart-${Date.now()}@example.test`,
      source: "WEBSITE",
    });
    expect([200, 201]).toContain(created.status);
    const createdId = String((created.body as { id: unknown }).id);

    await app.engine.restart(app.pluginControlUrl);
    expect(app.specmatic.process.pid).toBe(jvmPid);

    // Force the newly booted runtime to reload through the admin control plane.
    // The endpoint waits for the plugin ready notification and fixture refresh,
    // so the following business request does not need a long readiness poll.
    const forceReload = await fetch(`${app.engineUrl}/_admin/force-reload`, { method: "POST" });
    expect(forceReload.status).toBe(200);

    const afterRestart = await requestThroughSpecmatic(app.stubUrl, "GET", `/leads/${createdId}`);
    expect(afterRestart.status).toBe(404);
    expect(afterRestart.body).toEqual(expect.objectContaining({ error: "ENTITY_ABSENCE" }));

    const fixtures = await getFixtures(app.engineUrl);
    expect(fixtures.fixtures.length).toBeGreaterThan(0);
    expect(fixtures.checksum).toEqual(expect.any(String));
  }, 60_000);
});
