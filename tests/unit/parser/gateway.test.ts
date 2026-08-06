import { createYamlRuntimeExtensions } from '../../../src/parser/gateway.js';

type YamlRuntimeSystem = Parameters<typeof createYamlRuntimeExtensions>[0];

function systemWithReload(reloadConfiguration?: () => Promise<unknown>): YamlRuntimeSystem {
  const random = () => 0;
  return {
    clock: { nowMs: () => 1_000 },
    program: {
      dependencies: {
        clock: { offsetMs: () => 0 },
        helpers: {
          now: () => '2030-01-01T00:00:00.000Z',
          uuid: () => 'fault-1',
          random,
        },
      },
    },
    ...(reloadConfiguration === undefined ? {} : { reloadConfiguration }),
  };
}

describe('YAML runtime gateway extensions', () => {
  it('parses an admin fault registration through the parser-owned extension', () => {
    const extensions = createYamlRuntimeExtensions(systemWithReload());
    const result = extensions.parseFaultRegistration?.({
      name: 'temporary-outage',
      match: { operationId: 'createOrder', condition: 'true' },
      response: { status: 503, body: { error: 'outage' } },
      ttlMs: 5_000,
    });

    expect(result).toMatchObject({ ttlMs: 5_000, rule: { name: 'temporary-outage' } });
    expect(extensions.reloadConfiguration).toBeUndefined();
  });

  it('normalizes structured and unstructured reload failures into typed transport errors', async () => {
    const structured = createYamlRuntimeExtensions(
      systemWithReload(async () => {
        throw {
          status: 422,
          body: { code: 'CONFIG_INVALID', messages: ['bad yaml', 42] },
        };
      }),
    );
    await expect(structured.reloadConfiguration?.()).rejects.toMatchObject({
      status: 422,
      body: { code: 'CONFIG_INVALID', messages: ['bad yaml'] },
    });

    const detailed = createYamlRuntimeExtensions(
      systemWithReload(async () => {
        throw { details: { code: 'DSL_INVALID' }, message: 'invalid definition' };
      }),
    );
    await expect(detailed.reloadConfiguration?.()).rejects.toMatchObject({
      status: 400,
      body: { code: 'DSL_INVALID', messages: ['invalid definition'] },
    });

    const fallback = createYamlRuntimeExtensions(
      systemWithReload(async () => {
        throw new Error('unexpected failure');
      }),
    );
    await expect(fallback.reloadConfiguration?.()).rejects.toMatchObject({
      status: 400,
      body: { code: 'BOOT_ERR_DSL_SCHEMA_VIOLATION', messages: ['unexpected failure'] },
    });
  });

  it('uses a supplied response code and preserves a non-500 status', async () => {
    const extensions = createYamlRuntimeExtensions(
      systemWithReload(async () => {
        throw { status: 409, code: 'RELOAD_CONFLICT', message: 'reload conflict', body: null };
      }),
    );

    await expect(extensions.reloadConfiguration?.()).rejects.toMatchObject({
      status: 409,
      body: { code: 'RELOAD_CONFLICT', messages: ['reload conflict'] },
    });
  });
});
