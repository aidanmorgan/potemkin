import type { RuntimeGatewayExtensions } from '../http/runtimeGatewayTypes.js';
import type { RuntimeSystem } from '../runtime/system.js';
import { isRecord, type JsonObject } from '../contracts/value.js';
import { parseRuntimeFaultRegistration } from './runtimeAdmin.js';
import { RuntimeExecutionError } from '../core/errors.js';
import { createCelEvaluator } from '../cel/evaluator.js';

type YamlRuntimeSystem = {
  readonly clock: Pick<RuntimeSystem['clock'], 'nowMs'>;
  readonly program: {
    readonly dependencies: {
      readonly clock: Pick<RuntimeSystem['program']['dependencies']['clock'], 'offsetMs'>;
      readonly helpers: Pick<
        RuntimeSystem['program']['dependencies']['helpers'],
        'now' | 'uuid' | 'random'
      >;
    };
  };
  readonly reloadConfiguration?: RuntimeSystem['reloadConfiguration'];
};

/**
 * Bind parser-owned admin operations to the source-independent HTTP gateway.
 * The gateway itself only knows about the generic extension callbacks.
 */
export function createYamlRuntimeExtensions(system: YamlRuntimeSystem): RuntimeGatewayExtensions & {
  readonly reloadConfiguration?: () => Promise<unknown>;
} {
  const dependencies = system.program.dependencies;
  const cel = createCelEvaluator({
    externalClockOffset: dependencies.clock.offsetMs,
    uuid: dependencies.helpers.uuid,
    random: dependencies.helpers.random,
    now: dependencies.helpers.now,
  });
  const reload = system.reloadConfiguration;
  const reloadConfiguration =
    reload === undefined
      ? undefined
      : async (): Promise<unknown> => {
          try {
            return await reload();
          } catch (error) {
            const result = reloadError(error);
            const message = Array.isArray(result.body['messages'])
              ? result.body['messages'].join('; ')
              : 'Configuration reload failed';
            throw new RuntimeExecutionError(result.status, message, result.body);
          }
        };
  return {
    parseFaultRegistration: (value) =>
      parseRuntimeFaultRegistration(value, { nowMs: system.clock.nowMs(), cel }),
    ...(reloadConfiguration === undefined ? {} : { reloadConfiguration }),
  };
}

function reloadError(error: unknown): { readonly status: number; readonly body: JsonObject } {
  const candidate = isRecord(error) ? error : undefined;
  const details =
    candidate !== undefined && isRecord(candidate.details) ? candidate.details : undefined;
  const body = candidate !== undefined && isRecord(candidate.body) ? candidate.body : undefined;
  const status = typeof candidate?.status === 'number' ? candidate.status : 500;
  const code =
    typeof body?.code === 'string'
      ? body.code
      : typeof details?.code === 'string'
        ? details.code
        : typeof candidate?.code === 'string'
          ? candidate.code
          : 'BOOT_ERR_DSL_SCHEMA_VIOLATION';
  const messages = Array.isArray(body?.messages)
    ? body.messages.filter((message): message is string => typeof message === 'string')
    : [
        typeof body?.message === 'string'
          ? body.message
          : typeof candidate?.message === 'string'
            ? candidate.message
            : String(error),
      ];
  return { status: status === 500 ? 400 : status, body: { code, messages } };
}
