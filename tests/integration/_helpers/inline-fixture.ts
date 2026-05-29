/**
 * Inline CRM fixture that provides a minimal equivalent of the canonical
 * `tests/fixtures/index.ts` for integration and acceptance tests.
 *
 * Migrated from the banking inline fixture to the CRM domain (Nuisance Bureau).
 * Delegates to `loadFixture` from the canonical fixtures index.
 *
 * Seeded CRM IDs (from tests/fixtures/crm/dsl/):
 *  Lead:     00000000-0000-7000-8000-000000000010  (Apex Solutions Ltd, NEW)
 *            00000000-0000-7000-8000-000000000011  (BlueSky Tech, CONTACTED)
 *            00000000-0000-7000-8000-000000000012  (Cornerstone Corp, QUALIFIED)
 *            00000000-0000-7000-8000-000000000013  (Delta Dynamics, DISQUALIFIED)
 *            00000000-0000-7000-8000-000000000014  (Echo Enterprises, NEW)
 *  Campaign: 00000000-0000-7000-8000-000000000001  (Q1 Website Leads, ACTIVE)
 *            00000000-0000-7000-8000-000000000002  (Partner Referral Drive, DRAFT)
 *  Agent:    00000000-0000-7000-8000-000000000003  (Alice Thompson, AVAILABLE)
 *            00000000-0000-7000-8000-000000000004  (Bob Martinez, AVAILABLE)
 *            00000000-0000-7000-8000-000000000005  (Carla Nguyen, OFFLINE)
 *  Call:     00000000-0000-7000-8000-000000000030  (seeded call for BlueSky)
 *            00000000-0000-7000-8000-000000000031  (seeded call for Cornerstone)
 */

import type { BootInput } from '../../../src/engine/boot.js';
import { loadFixture } from '../../fixtures/index.js';

export interface CrmFixture extends BootInput {
  readonly leadIds: {
    readonly apexSolutions: string;
    readonly blueSkyTech: string;
    readonly cornerstoneQualified: string;
  };
  readonly campaignIds: {
    readonly q1Website: string;
  };
  readonly agentIds: {
    readonly alice: string;
  };
}

export async function loadInlineCrmFixture(): Promise<CrmFixture> {
  const base = await loadFixture();
  return {
    ...base,
    leadIds: {
      apexSolutions: '00000000-0000-7000-8000-000000000010',
      blueSkyTech: '00000000-0000-7000-8000-000000000011',
      cornerstoneQualified: '00000000-0000-7000-8000-000000000012',
    },
    campaignIds: {
      q1Website: '00000000-0000-7000-8000-000000000001',
    },
    agentIds: {
      alice: '00000000-0000-7000-8000-000000000003',
    },
  };
}
