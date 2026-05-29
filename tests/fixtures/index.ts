import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BootInput } from '../../src';
import { loadOpenApi } from '../../src';
import { compileDsl } from '../../src/dsl/parser';

export async function loadCrmFixture(fixtureName: string = 'crm'): Promise<BootInput> {
  const dir = path.join(__dirname, fixtureName);
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
  const compiledDsl = await compileDsl(dslModules);
  return { openapi, compiledDsl };
}

// loadCrmFixtureWithGlobal returns the BootInput plus the raw global YAML
// and a scripts dir. Tests that need Tier-2 features (sagas, idempotency,
// derived projections) compile the full bundle via compileDsl(modules, globalYaml).
export async function loadCrmFixtureWithGlobal(
  fixtureName: string = 'crm',
): Promise<BootInput & {
  readonly globalYaml: string;
  readonly scriptsDir: string;
  readonly dslModules: readonly { name: string; yaml: string }[];
}> {
  const dir = path.join(__dirname, fixtureName);
  const openapi = await loadOpenApi(path.join(dir, 'openapi/nuisance-bureau.yaml'));
  const read = (p: string) => fs.readFileSync(path.join(dir, p), 'utf8');
  const dslModules = [
    { name: 'lead', yaml: read('dsl/lead.yaml') },
    { name: 'campaign', yaml: read('dsl/campaign.yaml') },
    { name: 'agent', yaml: read('dsl/agent.yaml') },
    { name: 'call', yaml: read('dsl/call.yaml') },
    { name: 'opportunity', yaml: read('dsl/opportunity.yaml') },
    { name: 'leadById', yaml: read('dsl/lead-by-id.yaml') },
    { name: 'campaignById', yaml: read('dsl/campaign-by-id.yaml') },
    { name: 'agentById', yaml: read('dsl/agent-by-id.yaml') },
    { name: 'callById', yaml: read('dsl/call-by-id.yaml') },
    { name: 'opportunityById', yaml: read('dsl/opportunity-by-id.yaml') },
    { name: 'leadContact', yaml: read('dsl/lead-contact.yaml') },
    { name: 'leadQualify', yaml: read('dsl/lead-qualify.yaml') },
    { name: 'leadDisqualify', yaml: read('dsl/lead-disqualify.yaml') },
    { name: 'leadConvert', yaml: read('dsl/lead-convert.yaml') },
    { name: 'leadDNC', yaml: read('dsl/lead-dnc.yaml') },
    { name: 'campaignActivate', yaml: read('dsl/campaign-activate.yaml') },
    { name: 'campaignPause', yaml: read('dsl/campaign-pause.yaml') },
    { name: 'campaignComplete', yaml: read('dsl/campaign-complete.yaml') },
    { name: 'agentStatus', yaml: read('dsl/agent-status.yaml') },
    { name: 'opportunityAdvance', yaml: read('dsl/opportunity-advance.yaml') },
    { name: 'opportunityClose', yaml: read('dsl/opportunity-close.yaml') },
  ];
  const globalPath = path.join(dir, 'dsl/global.yaml');
  const globalYaml = fs.existsSync(globalPath) ? fs.readFileSync(globalPath, 'utf8') : '';
  const scriptsDir = path.join(dir, 'scripts');
  const compiledDsl = await compileDsl(dslModules, globalYaml || undefined);
  return { openapi, compiledDsl, globalYaml, scriptsDir, dslModules };
}
