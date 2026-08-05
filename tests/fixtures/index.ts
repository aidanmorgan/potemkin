import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadOpenApi } from '../../src/contract/loader';
import type { OpenApiDoc } from '../../src/contract/loader';
import type { YamlProgramInput } from '../../src/parser/public';
import type { ScanConfig } from '../../src/contracts/config';

/** TypeScript scan config used by fixtures with authored modules. */
const TYPESCRIPT_SCAN: ScanConfig = {
  scan: [{ include: ['typescript/**/*.ts'], exclude: ['**/*.test.ts', '**/*.d.ts'] }],
};

/**
 * Resolve a fixture's on-disk directory. The canonical CRM and Stripe
 * simulations are standalone examples under examples/; every other fixture lives under
 * tests/fixtures/<name>. Keeping this in one place lets the engine and the
 * full-Specmatic harness agree on where a fixture's files live.
 */
export function resolveFixtureDir(fixtureName: string): string {
  if (fixtureName === 'crm' || fixtureName === 'stripe') {
    return path.resolve(__dirname, '..', '..', 'examples', fixtureName);
  }
  return path.join(__dirname, fixtureName);
}

export interface FixtureYamlInput {
  readonly openapi: OpenApiDoc;
  readonly yamlProgram: YamlProgramInput;
  readonly typescript: ScanConfig;
  readonly typescriptScanCwd: string;
}

export async function loadFixture(fixtureName: string = 'crm'): Promise<FixtureYamlInput> {
  const dir = resolveFixtureDir(fixtureName);
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
    { name: 'opportunityAddLineItem', yaml: read('dsl/opportunity-add-line-item.yaml') },
    // Sub-path boundaries for nested-graph append actions
    { name: 'leadAddNote', yaml: read('dsl/lead-add-note.yaml') },
    { name: 'callAddTranscript', yaml: read('dsl/call-add-transcript.yaml') },
  ];
  return {
    openapi,
    yamlProgram: { modules: dslModules },
    typescript: TYPESCRIPT_SCAN,
    typescriptScanCwd: dir,
  };
}

// Returns the YAML runtime input, raw global YAML, and raw module list. The
// parser owns compilation into RuntimeProgram.
export async function loadFixtureWithGlobal(fixtureName: string = 'crm'): Promise<
  FixtureYamlInput & {
    readonly globalYaml: string;
    readonly dslModules: readonly { name: string; yaml: string }[];
  }
> {
  const dir = resolveFixtureDir(fixtureName);
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
    { name: 'opportunityAddLineItem', yaml: read('dsl/opportunity-add-line-item.yaml') },
    { name: 'leadAddNote', yaml: read('dsl/lead-add-note.yaml') },
    { name: 'callAddTranscript', yaml: read('dsl/call-add-transcript.yaml') },
  ];
  const globalPath = path.join(dir, 'dsl/global.yaml');
  const globalYaml = fs.existsSync(globalPath) ? fs.readFileSync(globalPath, 'utf8') : '';
  return {
    openapi,
    yamlProgram: { modules: dslModules, ...(globalYaml === '' ? {} : { globalYaml }) },
    globalYaml,
    dslModules,
    typescript: TYPESCRIPT_SCAN,
    typescriptScanCwd: dir,
  };
}

/** Resolve the single OpenAPI document for a fixture's `openapi/` directory. */
function resolveOpenApiPath(dir: string): string {
  const openapiDir = path.join(dir, 'openapi');
  const files = fs
    .readdirSync(openapiDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`Fixture at ${dir} has no OpenAPI document under openapi/`);
  }
  // Prefer the conventional name when present; otherwise take the only file.
  const preferred = files.find((f) => f === 'nuisance-bureau.yaml') ?? files[0];
  return path.join(openapiDir, preferred);
}

export interface EngineFixture {
  readonly openapi: OpenApiDoc;
  /** Absolute path to the fixture's potemkin.yml — boot the engine via this. */
  readonly potemkinConfigPath: string;
  /** The fixture directory. */
  readonly dir: string;
}

/**
 * Generic, fixture-aware loader used by the e2e engine driver.
 *
 * Resolves the OpenAPI document from `<fixture>/openapi/` (any filename) and
 * the fixture's potemkin.yml. The engine boots through potemkinConfigPath so
 * that loadPotemkinConfig performs the canonical module globbing (+ exclusions),
 * global-config merge (auth/sagas/idempotency/seeds/overlay/workflow), and
 * TypeScript factory scan — exactly as production does. This is the single
 * supported boot path for every fixture (crm, crm-jwt, crm-session, and the
 * configured source matrix).
 */
export async function loadEngineFixture(fixtureName = 'crm'): Promise<EngineFixture> {
  const dir = resolveFixtureDir(fixtureName);
  const openapi = await loadOpenApi(resolveOpenApiPath(dir));
  const potemkinConfigPath = path.join(dir, 'potemkin.yml');
  if (!fs.existsSync(potemkinConfigPath)) {
    throw new Error(`Fixture "${fixtureName}" has no potemkin.yml at ${potemkinConfigPath}`);
  }
  return { openapi, potemkinConfigPath, dir };
}
