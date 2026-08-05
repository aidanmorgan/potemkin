import { loadOpenApi } from '../../../src/contract/loader';
import { createDefaultRuntimeHost } from '../../../src/runtime/host';
import { bootRuntime } from '../../../src/runtime/system';
import { compileProgram } from '../../../src/authoring/compiler';
import { simulation } from '../../../src/authoring/builders';

const OPENAPI = `
openapi: "3.0.3"
info: { title: boot dependencies, version: "1.0.0" }
paths:
  /items:
    get:
      operationId: listItems
      responses:
        "200": { description: OK, content: { application/json: { schema: { type: array, items: { type: object } } } } }
`;

describe('runtime boot dependency composition', () => {
  it('injects default stores into the canonical program before engine creation', async () => {
    const system = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi: await loadOpenApi(OPENAPI),
      programFactory: ({ dependencies }) => compileProgram(simulation().build(), { dependencies }),
    });

    expect(system.program.dependencies.events).toBeDefined();
    expect(system.program.dependencies.state).toBeDefined();
    expect(system.program.dependencies.idempotency).toBeDefined();
    expect(system.program.dependencies.faults).toBe(system.faults);

    await system.dispose();
  });
});
