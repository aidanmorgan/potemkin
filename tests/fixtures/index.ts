import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BootInput } from '../../src';
import { loadOpenApi } from '../../src';

export async function loadCrmFixture(): Promise<BootInput> {
  const dir = path.join(__dirname, 'crm');
  const openapi = await loadOpenApi(path.join(dir, 'openapi/nuisance-bureau.yaml'));
  const read = (p: string) => fs.readFileSync(path.join(dir, p), 'utf8');
  const dslModules = [
    // Primary collection boundaries
    { name: 'lead', yaml: read('dsl/lead.yaml') },
    { name: 'campaign', yaml: read('dsl/campaign.yaml') },
    { name: 'agent', yaml: read('dsl/agent.yaml') },
    { name: 'call', yaml: read('dsl/call.yaml') },
    { name: 'opportunity', yaml: read('dsl/opportunity.yaml') },
    // Sub-path boundaries for GET /x/{id}
    { name: 'leadById', yaml: read('dsl/lead-by-id.yaml') },
    { name: 'campaignById', yaml: read('dsl/campaign-by-id.yaml') },
    { name: 'agentById', yaml: read('dsl/agent-by-id.yaml') },
    { name: 'callById', yaml: read('dsl/call-by-id.yaml') },
    { name: 'opportunityById', yaml: read('dsl/opportunity-by-id.yaml') },
    // Sub-path boundaries for lead actions
    { name: 'leadContact', yaml: read('dsl/lead-contact.yaml') },
    { name: 'leadQualify', yaml: read('dsl/lead-qualify.yaml') },
    { name: 'leadDisqualify', yaml: read('dsl/lead-disqualify.yaml') },
    { name: 'leadConvert', yaml: read('dsl/lead-convert.yaml') },
    { name: 'leadDNC', yaml: read('dsl/lead-dnc.yaml') },
    // Sub-path boundaries for campaign actions
    { name: 'campaignActivate', yaml: read('dsl/campaign-activate.yaml') },
    { name: 'campaignPause', yaml: read('dsl/campaign-pause.yaml') },
    { name: 'campaignComplete', yaml: read('dsl/campaign-complete.yaml') },
    // Sub-path boundaries for agent actions
    { name: 'agentStatus', yaml: read('dsl/agent-status.yaml') },
    // Sub-path boundaries for opportunity actions
    { name: 'opportunityAdvance', yaml: read('dsl/opportunity-advance.yaml') },
    { name: 'opportunityClose', yaml: read('dsl/opportunity-close.yaml') },
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
