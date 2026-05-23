import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { BootError } from '../../../src/errors.js';
import {
  BANKING_OPENAPI_YAML,
  CUSTOMER_DSL_YAML,
  CUSTOMER_COLLECTION_DSL_YAML,
  LOAN_DSL_YAML,
  LOAN_COLLECTION_DSL_YAML,
} from '../support/world.js';

// REQ-8: Boot compiles all DSL modules
Then('the compiled DSL should have at least {int} boundaries', function (this: SimWorld, min: number) {
  assert.ok(this.sys, 'System not booted');
  assert.ok(
    this.sys.dsl.boundaries.length >= min,
    `Expected at least ${min} boundaries but found ${this.sys.dsl.boundaries.length}`,
  );
});

Then('each boundary should have behaviors compiled', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  for (const boundary of this.sys.dsl.boundaries) {
    assert.ok(
      boundary.behaviors !== undefined,
      `Boundary '${boundary.boundary}' should have behaviors array`,
    );
  }
});

// REQ-9: DSL mapped to OpenAPI contract paths
Then('each boundary should reference a valid OpenAPI path', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  for (const boundary of this.sys.dsl.boundaries) {
    const openApiPaths = Object.keys(this.sys.openapi.paths);
    assert.ok(
      openApiPaths.includes(boundary.contractPath),
      `Boundary '${boundary.boundary}' contractPath '${boundary.contractPath}' must be in OpenAPI paths`,
    );
  }
});

Then('the DSL byContractPath index should be populated', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const contractPaths = Object.keys(this.sys.dsl.byContractPath);
  assert.ok(contractPaths.length > 0, 'byContractPath should be non-empty');
});

// REQ-10: Initialization data ingested as baseline domain events
Then('the event log should contain baseline events after boot', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const events = this.getEvents();
  const baseline = events.filter(e => e.type === 'BaselineEntityCreatedEvent');
  assert.ok(baseline.length > 0, 'There should be baseline events after boot');
});

Then('the frozen baseline should be preserved', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  assert.ok(this.sys.frozenBaseline.length > 0, 'frozenBaseline should be non-empty');
  assert.ok(Object.isFrozen(this.sys.frozenBaseline), 'frozenBaseline array should be frozen');
});

// REQ-11: State Graph reflects baseline after boot
Then('the state graph should be non-empty after boot', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  assert.ok(this.sys.graph.size() > 0, 'State graph should be non-empty after baseline hydration');
});

Then('baseline entities should appear in the state graph', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const customer = this.getState('customer-seed-001');
  assert.ok(customer !== null, 'Seeded customer should be in state graph');
});

Then('the seeded customer should be in the state graph', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const customer = this.getState('customer-seed-001');
  assert.ok(customer !== null, 'customer-seed-001 should exist in state graph');
  const c = customer as Record<string, unknown>;
  assert.strictEqual(c['name'], 'Alice', 'Seeded customer name should be Alice');
});

Then('the seeded loan should be in the state graph', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const loan = this.getState('loan-seed-001');
  assert.ok(loan !== null, 'loan-seed-001 should exist in state graph');
});

// Boot error checks (for REQ-23)
When('I attempt to boot with DSL {string}', async function (this: SimWorld, dslYaml: string) {
  try {
    const openapi = await loadOpenApi(BANKING_OPENAPI_YAML);
    await bootSystem({
      openapi,
      dslModules: [{ name: 'bad-dsl', yaml: dslYaml }],
    });
    this.ctx['bootError'] = null;
  } catch (err) {
    this.ctx['bootError'] = err;
  }
});

Then('boot should fail with a BootError', function (this: SimWorld) {
  const err = this.ctx['bootError'];
  assert.ok(err instanceof BootError, `Expected BootError but got ${String(err)}`);
});

Then('the BootError code should be {string}', function (this: SimWorld, code: string) {
  const err = this.ctx['bootError'] as BootError;
  assert.ok(err instanceof BootError, 'Expected BootError');
  assert.strictEqual(err.code, code, `Expected code '${code}' got '${err.code}'`);
});
