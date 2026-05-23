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
