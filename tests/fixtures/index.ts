import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BootInput } from '../../src';
import { loadOpenApi } from '../../src';

export async function loadBankingFixture(): Promise<BootInput> {
  const fixtureDir = __dirname;
  const openApiPath = path.join(fixtureDir, 'openapi/banking.yaml');
  const openapi = await loadOpenApi(openApiPath);
  const dslModules = [
    { name: 'customer', yaml: fs.readFileSync(path.join(fixtureDir, 'dsl/customer.yaml'), 'utf8') },
    { name: 'loan-account', yaml: fs.readFileSync(path.join(fixtureDir, 'dsl/loan-account.yaml'), 'utf8') },
  ];
  return { openapi, dslModules };
}

export async function loadCrmFixture(): Promise<BootInput> {
  const dir = path.join(__dirname, 'crm');
  const openapi = await loadOpenApi(path.join(dir, 'openapi/nuisance-bureau.yaml'));
  const read = (p: string) => fs.readFileSync(path.join(dir, p), 'utf8');
  const dslModules = [
    { name: 'lead', yaml: read('dsl/lead.yaml') },
    { name: 'campaign', yaml: read('dsl/campaign.yaml') },
    { name: 'agent', yaml: read('dsl/agent.yaml') },
    { name: 'call', yaml: read('dsl/call.yaml') },
    { name: 'opportunity', yaml: read('dsl/opportunity.yaml') },
  ];
  return { openapi, dslModules };
}

/**
 * Load CRM fixture with Tier-2 global config (sagas, idempotency, derived projections).
 * Returns both a BootInput (for bootSystem) and the raw globalYaml for compileDsl.
 */
export async function loadCrmFixtureWithGlobal(): Promise<BootInput & { readonly globalYaml: string }> {
  const base = await loadCrmFixture();
  const dir = path.join(__dirname, 'crm');
  const globalYaml = fs.readFileSync(path.join(dir, 'dsl/global.yaml'), 'utf8');
  return { ...base, globalYaml };
}
