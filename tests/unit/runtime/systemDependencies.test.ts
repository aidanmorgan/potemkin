import { loadOpenApi } from '../../../src/contract/loader.js';
import type { RuntimeHelpers } from '../../../src/model/runtime.js';
import type { RuntimeClock } from '../../../src/contracts/ports.js';
import { createRuntimeDataGenerator } from '../../../src/model/data.js';
import type { PluginControlClient } from '../../../src/contracts/lifecycle.js';
import { bootRuntime } from '../../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../../src/runtime/host.js';
import { bootYamlRuntime } from '../../../src/parser/runtime.js';
import { compileProgram } from '../../../src/authoring/compiler.js';
import { simulation } from '../../../src/authoring/builders.js';
import { createContractValidator } from '../../../src/contract/validator.js';
import { runtimeContract } from '../../../src/runtime/system.js';
import { operationId, type OperationId } from '../../../src/domain/references.js';

const FIXED_NOW = '2030-01-02T03:04:05.000Z';

const OPENAPI = `
openapi: "3.0.3"
info: { title: dependency injection, version: "1.0.0" }
paths:
  /empty:
    get:
      operationId: getEmpty
      responses:
        "200": { description: ok }
`;

function runtimeHelpers(): RuntimeHelpers {
  const random = () => 0;
  return {
    now: () => FIXED_NOW,
    uuid: () => '00000000-0000-7000-8000-000000000001',
    random,
    data: createRuntimeDataGenerator(random),
    clone: <T>(value: T) => structuredClone(value),
  };
}

function runtimeClock(): RuntimeClock {
  return {
    nowMs: () => 1_893_468_245_000,
    offsetMs: () => 0,
    advance: () => 0,
    reset: () => undefined,
  };
}

function pluginControl(): jest.Mocked<PluginControlClient> {
  return {
    notifyReady: jest.fn().mockResolvedValue({ ok: true, attempts: 1, durationMs: 0 }),
    notifyShutdown: jest.fn().mockResolvedValue({ ok: true, attempts: 1, durationMs: 0 }),
  };
}

describe('runtime host dependency injection', () => {
  it('shapes only operation/status pairs declared by the contract', async () => {
    const openapi = await loadOpenApi(`
      openapi: "3.0.3"
      info: { title: error shaping, version: "1.0.0" }
      paths:
        /guarded:
          post:
            operationId: guarded
            responses:
              "422":
                description: rejected
                content:
                  application/json:
                    schema:
                      type: object
                      required: [error]
                      properties:
                        error: { type: string }
        /undeclared:
          post:
            operationId: undeclared
            responses:
              "200": { description: ok }
    `);
    const contract = runtimeContract(openapi, createContractValidator(openapi));
    const generic = { code: 'UNHANDLED_OPERATION', message: 'guard failed' };

    expect(contract.shapeError?.(operationId('guarded'), 422, generic)).toEqual({
      error: 'UNHANDLED_OPERATION',
    });
    expect(contract.shapeError?.(operationId('undeclared'), 422, generic)).toEqual(generic);
  });

  it('returns branded operation IDs from the compiled contract route boundary', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const contract = runtimeContract(openapi, createContractValidator(openapi));

    const operationId: OperationId | undefined = contract.operationIdFor('/empty', 'GET');

    expect(operationId).toBe('getEmpty');
    expect(contract.operationIdFor('/empty', 'get')).toBe(operationId);
  });

  it.each(['YAML', 'TypeScript'] as const)(
    '%s lifecycle notifications use the injected helper clock',
    async (source) => {
      const openapi = await loadOpenApi(OPENAPI);
      const control = pluginControl();
      const dependencies = {
        helpers: runtimeHelpers(),
        clock: runtimeClock(),
        sessionToken: () => 'injected-session-token',
        pluginControl: control,
        version: 'test-version',
      };
      const system =
        source === 'YAML'
          ? await bootYamlRuntime({
              host: createDefaultRuntimeHost(),
              openapi,
              yamlProgram: {
                modules: [
                  {
                    name: 'empty.yaml',
                    yaml: 'boundary: Empty\ncontract_path: /empty\nbehaviors: []\nreducers: []',
                  },
                ],
              },
              ...dependencies,
            })
          : await bootRuntime({
              host: createDefaultRuntimeHost(),
              openapi,
              programFactory: ({ dependencies: runtimeDependencies }) =>
                compileProgram(simulation().build(), { dependencies: runtimeDependencies }),
              ...dependencies,
            });

      expect(control.notifyReady).toHaveBeenCalledWith(
        expect.objectContaining({ startedAt: FIXED_NOW, version: 'test-version' }),
      );

      await system.dispose();

      expect(control.notifyShutdown).toHaveBeenCalledWith(
        expect.objectContaining({ stoppedAt: FIXED_NOW, version: 'test-version' }),
      );
    },
  );
});
