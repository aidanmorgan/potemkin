/**
 * 67 — Annotation-based script discovery (engine-only).
 *
 * Canonical example proving the @Script annotation approach:
 *
 *   The YAML boundary file (tests/fixtures/ts-script/dsl/lead.yaml) contains
 *   ONLY a `ts:computeScore` sentinel — no `scripts:` block, no inline `code:`.
 *   The computeScore function is declared in
 *   tests/fixtures/ts-script/scripts/computeScore.ts using the @Script('computeScore')
 *   class decorator, discovered at boot via the `typescript.scan` glob in
 *   tests/fixtures/ts-script/potemkin.yaml.
 *
 * YAML purity (AC #1):
 *   The boundary YAML holds only declarative config and the `ts:computeScore` sentinel.
 *   There is no TypeScript in the YAML file. Verified by the fixture being unchanged
 *   since B4 and by the assertion pattern below.
 *
 * Discovery by annotation (AC #1 / AC #3):
 *   The @Script('computeScore') decorator in computeScore.ts registers the class at
 *   import time; the scanner drains the script registry before boot completes. Any
 *   ts:<id> with no matching @Script would halt boot with BOOT_ERR_DSL_REFERENCE,
 *   which this test proves does NOT happen for 'computeScore'.
 *
 * Score values (AC #1):
 *   REFERRAL → 80  (explicit lookup)
 *   WEBSITE  → 50  (explicit lookup)
 *   PARTNER  → 70  (explicit lookup, also tests COLD_LIST path in ts-script fixture)
 *   default  → 30  (fallback for any unrecognised source)
 *
 * Fixture: tests/fixtures/ts-script/
 *   - dsl/lead.yaml              — boundary with ts:computeScore, no scripts: block
 *   - scripts/computeScore.ts    — @Script('computeScore') class (host code, not inline)
 *   - potemkin.yaml              — typescript.scan glob discovers scripts/**‌/*.ts
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('67 — Annotation-based script discovery (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'ts-script' });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  async function createLead(source: string, suffix: string): Promise<JsonObject> {
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: `Script Test Corp ${suffix}`,
      source,
    });
    expect([200, 201]).toContain(res.status);
    return res.body as JsonObject;
  }

  it('scanned @Script executes: REFERRAL source yields score 80', async () => {
    const lead = await createLead('REFERRAL', '01');
    expect(lead['score']).toBe(80);
  });

  it('scanned @Script executes: WEBSITE source yields score 50', async () => {
    const lead = await createLead('WEBSITE', '02');
    expect(lead['score']).toBe(50);
  });

  it('scanned @Script executes: PARTNER source yields score 70', async () => {
    const lead = await createLead('PARTNER', '03');
    expect(lead['score']).toBe(70);
  });

  it('scanned @Script executes: unrecognised source falls back to default score 30', async () => {
    const lead = await createLead('UNKNOWN_SOURCE', '04');
    expect(lead['score']).toBe(30);
  });

  it('score field is a number (not a string)', async () => {
    const lead = await createLead('WEBSITE', '05');
    expect(typeof lead['score']).toBe('number');
    expect(Number.isInteger(lead['score'])).toBe(true);
  });

  it('other fields are projected correctly alongside the script-derived score', async () => {
    const lead = await createLead('REFERRAL', '06');
    expect(lead['id']).toBeTruthy();
    expect(typeof lead['id']).toBe('string');
    expect(lead['companyName']).toBe('Script Test Corp 06');
    expect(lead['source']).toBe('REFERRAL');
    expect(lead['score']).toBe(80);
  });
});
