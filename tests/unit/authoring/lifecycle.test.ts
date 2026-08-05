import {
  defineLifecycle,
  lifecycleHook,
  runLifecyclePhase,
} from '../../../src/authoring/lifecycle.js';
import type { JsonObject } from '../../../src/contracts/value.js';

const baseContext = {
  command: {
    commandId: 'command-1',
    boundary: 'Widget',
    intent: 'mutation' as const,
    targetId: 'widget-1',
    payload: { name: 'before' },
    queryParams: {},
    httpMethod: 'PATCH',
    path: '/widgets/widget-1',
    origin: 'inbound' as const,
    depth: 0,
  },
  state: { nested: { value: 1 } },
  helpers: {
    uuid: () => 'uuid-1',
    now: () => '2026-01-01T00:00:00.000Z',
    deepClone: <T>(value: T) => structuredClone(value),
    deepMerge: (a: JsonObject, b: JsonObject) => ({ ...a, ...b }),
  },
};

describe('TypeScript lifecycle runner', () => {
  it('runs matching hooks sequentially and isolates each context snapshot', async () => {
    const seen: string[] = [];
    const definition = defineLifecycle({
      hooks: [
        lifecycleHook(
          'request',
          (context) => {
            seen.push(`${context.phase}:first`);
            // A hook cannot mutate the state snapshot supplied to another hook.
            try {
              (context.state as { nested: { value: number } }).nested.value = 99;
            } catch {
              // Object.freeze is intentional; mutation attempts are ignored by the test.
            }
          },
          'first',
        ),
        lifecycleHook(
          'request',
          (context) => {
            seen.push(
              `${context.phase}:second:${context.state?.['nested'] && (context.state['nested'] as { value: number }).value}`,
            );
          },
          'second',
        ),
        lifecycleHook('projection', () => {
          seen.push('projection');
        }),
      ],
    });

    await runLifecyclePhase(definition, 'request', baseContext, { nowMs: () => 0 });
    await runLifecyclePhase(definition, 'projection', baseContext, { nowMs: () => 0 });

    expect(seen).toEqual(['request:first', 'request:second:1', 'projection']);
  });

  it('aborts transactional phases at the first failing hook', async () => {
    const seen: string[] = [];
    const definition = defineLifecycle({
      hooks: [
        lifecycleHook('projection', () => {
          seen.push('first');
          throw new Error('projection failed');
        }),
        lifecycleHook('projection', () => {
          seen.push('second');
        }),
      ],
    });

    await expect(
      runLifecyclePhase(definition, 'projection', baseContext, { nowMs: () => 0 }),
    ).rejects.toThrow('projection failed');
    expect(seen).toEqual(['first']);
  });

  it('continues committed side-effect phases and reports each failure', async () => {
    const seen: string[] = [];
    const errors: string[] = [];
    const definition = defineLifecycle({
      hooks: [
        lifecycleHook(
          'post-commit',
          () => {
            seen.push('first');
            throw new Error('first failed');
          },
          'first',
        ),
        lifecycleHook(
          'post-commit',
          async () => {
            seen.push('second');
            throw new Error('second failed');
          },
          'second',
        ),
        lifecycleHook(
          'post-commit',
          () => {
            seen.push('third');
          },
          'third',
        ),
      ],
    });

    await runLifecyclePhase(definition, 'post-commit', baseContext, {
      failure: 'continue',
      nowMs: () => 0,
      onError: (error, name) => errors.push(`${name}:${(error as Error).message}`),
    });

    expect(seen).toEqual(['first', 'second', 'third']);
    expect(errors).toEqual(['first:first failed', 'second:second failed']);
  });
});
