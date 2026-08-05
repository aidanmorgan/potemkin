import { compileRuntime } from '../../../src/model/compiler.js';
import type {
  RuntimeBehavior,
  RuntimeBoundary,
  RuntimeDependencies,
  RuntimeEvent,
  RuntimeReaction,
  RuntimeSaga,
} from '../../../src/model/runtime.js';
import type { RuntimeDefinition } from '../../../src/model/index.js';

const dependencies = {} as RuntimeDependencies;

const event = (type: string): RuntimeEvent => ({ type, payload: {} });

const behavior = (overrides: Partial<RuntimeBehavior> = {}): RuntimeBehavior => ({
  name: 'create',
  operationId: 'create',
  emit: 'Created',
  ...overrides,
});

const boundary = (name: string, overrides: Partial<RuntimeBoundary> = {}): RuntimeBoundary => ({
  boundary: name,
  contractPath: `/${name.toLowerCase()}`,
  eventCatalog: [event('Created')],
  behaviors: [behavior()],
  reducers: [],
  ...overrides,
});

const compile = (definition: RuntimeDefinition) => compileRuntime(definition, dependencies);

describe('runtime model compiler validation', () => {
  it('indexes, freezes, and exposes valid source-neutral definitions', () => {
    const model = compile({
      boundaries: [boundary('Orders'), boundary('Users')],
      helpers: [{ name: 'slug', phases: ['response'], maxDurationMs: 50, invoke: () => 'orders' }],
      policies: {},
    });

    expect([...model.byBoundaryName.keys()]).toEqual(['Orders', 'Users']);
    expect(model.byContractPath.get('/orders')?.boundary).toBe('Orders');
    expect(model.helpers).toHaveLength(1);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.boundaries[0])).toBe(true);
  });

  it('rejects duplicate boundary names and contract paths', () => {
    expect(() => compile({ boundaries: [boundary('Orders'), boundary('Orders')] })).toThrow(
      expect.objectContaining({ code: 'RUNTIME_BOUNDARY_CONFLICT' }),
    );
    expect(() =>
      compile({ boundaries: [boundary('Orders'), boundary('Users', { contractPath: '/orders' })] }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_BOUNDARY_CONFLICT' }));
    expect(() =>
      compile({
        boundaries: [boundary('Orders')],
        helpers: [
          { name: 'slug', phases: ['response'], maxDurationMs: 50, invoke: () => 'orders' },
          { name: 'slug', phases: ['response'], maxDurationMs: 50, invoke: () => 'users' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_HELPER_CONFLICT' }));
  });

  it('rejects malformed domain references before indexing the runtime model', () => {
    expect(() => compile({ boundaries: [boundary(' ')] })).toThrow(
      expect.objectContaining({ code: 'RUNTIME_BUILDER_INVALID' }),
    );
    expect(() => compile({ boundaries: [boundary('Orders', { contractPath: 'orders' })] })).toThrow(
      expect.objectContaining({ code: 'RUNTIME_BUILDER_INVALID' }),
    );
    expect(() =>
      compile({
        boundaries: [boundary('Orders', { behaviors: [behavior({ operationId: ' ' })] })],
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_BUILDER_INVALID' }));
  });

  it('validates latency at both boundary and response policy levels', () => {
    expect(() => compile({ boundaries: [boundary('Orders', { latency: null as never })] })).toThrow(
      expect.objectContaining({ code: 'RUNTIME_LATENCY_INVALID' }),
    );
    expect(() =>
      compile({ boundaries: [boundary('Orders', { response: { latency: { minMs: -1 } } })] }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_LATENCY_INVALID' }));
  });

  it('validates emitted events and reducer event references', () => {
    expect(() =>
      compile({ boundaries: [boundary('Orders', { behaviors: [behavior({ emit: 'Missing' })] })] }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_EVENT_REFERENCE_INVALID' }));
    expect(() =>
      compile({ boundaries: [boundary('Orders', { reducers: [{ on: 'Missing' }] })] }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_EVENT_REFERENCE_INVALID' }));

    expect(() =>
      compile({
        boundaries: [
          boundary('Orders', {
            behaviors: [behavior({ emit: 'System.GenericUpdateEvent' })],
            reducers: [{ on: 'BaselineEntityCreatedEvent' }, { on: 'System.GenericUpdateEvent' }],
          }),
        ],
      }),
    ).not.toThrow();
  });

  it('validates dispatch targets before a source-neutral program is created', () => {
    const dispatch = { boundary: 'Payments', intent: 'mutation' as const, operationId: 'charge' };
    expect(() =>
      compile({
        boundaries: [
          boundary('Orders', { behaviors: [behavior({ dispatchCommands: [dispatch] })] }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_DISPATCH_REFERENCE_INVALID' }));
    expect(() =>
      compile({
        boundaries: [
          boundary('Orders', {
            behaviors: [
              behavior({
                dispatchCommands: [{ ...dispatch, boundary: 'Orders', operationId: 'missing' }],
              }),
            ],
          }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_DISPATCH_REFERENCE_INVALID' }));
    expect(() =>
      compile({
        boundaries: [
          boundary('Orders', { behaviors: [behavior({ dispatchCommands: [dispatch] })] }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_DISPATCH_REFERENCE_INVALID' }));
  });

  it('validates local and global reaction references', () => {
    const local: RuntimeReaction = { on: 'Created', boundary: 'Payments', emit: 'Created' };
    expect(() => compile({ boundaries: [boundary('Orders', { reactions: [local] })] })).toThrow(
      expect.objectContaining({ code: 'RUNTIME_REACTION_REFERENCE_INVALID' }),
    );
    const wrongEvent: RuntimeReaction = { on: 'Created', boundary: 'Orders', emit: 'Missing' };
    expect(() =>
      compile({ boundaries: [boundary('Orders', { reactions: [wrongEvent] })] }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_REACTION_REFERENCE_INVALID' }));
    expect(() =>
      compile({ boundaries: [boundary('Orders')], policies: { reactions: [local] } }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_REACTION_REFERENCE_INVALID' }));
    expect(() =>
      compile({ boundaries: [boundary('Orders')], policies: { reactions: [wrongEvent] } }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_REACTION_REFERENCE_INVALID' }));
  });

  it('validates saga trigger, steps, operations, and compensation', () => {
    const saga = (overrides: Partial<RuntimeSaga> = {}): RuntimeSaga => ({
      name: 'order-payment',
      trigger: { boundary: 'Orders', intent: 'mutation' },
      steps: [{ name: 'charge', boundary: 'Orders', intent: 'mutation', operationId: 'create' }],
      ...overrides,
    });
    expect(() =>
      compile({
        boundaries: [boundary('Orders')],
        policies: { sagas: [saga({ trigger: { boundary: 'Missing', intent: 'mutation' } })] },
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_SAGA_REFERENCE_INVALID' }));
    expect(() =>
      compile({
        boundaries: [boundary('Orders')],
        policies: {
          sagas: [
            saga({
              steps: [
                { name: 'charge', boundary: 'Missing', intent: 'mutation', operationId: 'create' },
              ],
            }),
          ],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_SAGA_REFERENCE_INVALID' }));
    expect(() =>
      compile({
        boundaries: [boundary('Orders')],
        policies: {
          sagas: [
            saga({
              steps: [
                { name: 'charge', boundary: 'Orders', intent: 'mutation', operationId: 'missing' },
              ],
            }),
          ],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_SAGA_REFERENCE_INVALID' }));
    expect(() =>
      compile({
        boundaries: [boundary('Orders')],
        policies: {
          sagas: [
            saga({
              steps: [
                {
                  name: 'charge',
                  boundary: 'Orders',
                  intent: 'mutation',
                  operationId: 'create',
                  compensation: { intent: 'mutation', operationId: 'missing' },
                },
              ],
            }),
          ],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_SAGA_REFERENCE_INVALID' }));
  });
});
