import type { RuntimeGatewayExtensions } from "../http/runtimeGatewayTypes.js";
import type { RuntimeSystem } from "../runtime/system.js";
import type { JsonObject } from "../types.js";
import { parseRuntimeFaultRegistration } from "./runtimeAdmin.js";
import { RuntimeExecutionError } from "../core/errors.js";
import { createCelEvaluator } from "../cel/evaluator.js";

/**
 * Bind parser-owned admin operations to the source-independent HTTP gateway.
 * The gateway itself only knows about the generic extension callbacks.
 */
export function createYamlRuntimeExtensions(system: RuntimeSystem): RuntimeGatewayExtensions & {
  readonly reloadConfiguration?: () => Promise<unknown>;
} {
  const dependencies = system.program.dependencies;
  const cel = createCelEvaluator({
    externalClockOffset: dependencies.clock.offsetMs,
    uuid: dependencies.helpers.uuid,
    random: dependencies.helpers.random,
    now: dependencies.helpers.now,
  });
  const reloadConfiguration =
    system.reloadConfiguration === undefined
      ? undefined
      : async (): Promise<unknown> => {
          try {
            return await system.reloadConfiguration!();
          } catch (error) {
            const result = reloadError(error);
            const message = Array.isArray(result.body["messages"])
              ? result.body["messages"].join("; ")
              : "Configuration reload failed";
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
  const candidate = error as {
    readonly status?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
    readonly body?: unknown;
  };
  const details =
    candidate.details !== null &&
    typeof candidate.details === "object" &&
    !Array.isArray(candidate.details)
      ? (candidate.details as Record<string, unknown>)
      : undefined;
  const body =
    candidate.body !== null && typeof candidate.body === "object" && !Array.isArray(candidate.body)
      ? (candidate.body as Record<string, unknown>)
      : undefined;
  const status = typeof candidate.status === "number" ? candidate.status : 500;
  const code =
    typeof body?.code === "string"
      ? body.code
      : typeof details?.code === "string"
        ? details.code
        : typeof candidate.code === "string"
          ? candidate.code
          : "BOOT_ERR_DSL_SCHEMA_VIOLATION";
  const messages = Array.isArray(body?.messages)
    ? body.messages.filter((message): message is string => typeof message === "string")
    : [
        typeof body?.message === "string"
          ? body.message
          : typeof candidate.message === "string"
            ? candidate.message
            : String(error),
      ];
  return { status: status === 500 ? 400 : status, body: { code, messages } as JsonObject };
}
