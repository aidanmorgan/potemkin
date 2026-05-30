import { Before, After, AfterAll } from '@cucumber/cucumber';
import type { SimWorld } from './world.js';
import { closeSharedServer } from './world.js';

/**
 * Before each scenario: ensure system is booted and reset state to baseline.
 * Skipped for scenarios tagged @noBoot.
 */
Before({ tags: 'not @noBoot' }, async function (this: SimWorld) {
  await this.ensureBooted();
  await this.resetState();
  this.lastResponse = undefined;
  this.lastError = undefined;
  this.ctx = {};
});

/**
 * Before @noBoot scenarios: only clear per-scenario state.
 */
Before({ tags: '@noBoot' }, function (this: SimWorld) {
  this.lastResponse = undefined;
  this.lastError = undefined;
  this.ctx = {};
});

/**
 * After each scenario: clear transient response state and close any
 * per-scenario persistent server created by bootWithCustomDsl.
 */
After(async function (this: SimWorld) {
  this.lastResponse = undefined;
  this.lastError = undefined;
  await this.closeOwnServer();
});

/**
 * After the whole suite: close the shared persistent server.
 */
AfterAll(async function () {
  await closeSharedServer();
});
