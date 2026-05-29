/**
 * Sanity check that the JWT-flavoured CRM fixture loads cleanly and that the
 * auth block ends up on the compiled DSL.
 */
import { compileDsl } from '../../../src/dsl/parser';
import { loadFixtureWithGlobal } from '../../fixtures/index';

describe('fixtures/crm-jwt', () => {
  it('compiles with auth.mode=jwt', async () => {
    const fixture = await loadFixtureWithGlobal('crm-jwt');
    const dsl = await compileDsl(fixture.dslModules, fixture.globalYaml, fixture.scriptsDir);
    expect(dsl.auth).toBeDefined();
    expect(dsl.auth?.mode).toBe('jwt');
    expect(dsl.auth?.jwt?.secret).toBeTruthy();
    expect(dsl.auth?.jwt?.issuer).toBe('potemkin-test');
    expect(dsl.auth?.jwt?.audience).toBe('potemkin-api');
  });

  it('default crm fixture has no auth block (backward compat)', async () => {
    const fixture = await loadFixtureWithGlobal();
    const dsl = await compileDsl(fixture.dslModules, fixture.globalYaml, fixture.scriptsDir);
    expect(dsl.auth).toBeUndefined();
  });
});
