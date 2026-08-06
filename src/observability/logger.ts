import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { v7 } from 'uuid';

const loadOptionalModule = createRequire(__filename);
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

function isLogLevel(value: string | undefined): value is pino.LevelWithSilent {
  return value !== undefined && (LOG_LEVELS as readonly string[]).includes(value);
}

function isPrettyFactory(
  value: unknown,
): value is (options: Readonly<Record<string, unknown>>) => NodeJS.WritableStream {
  return typeof value === 'function';
}

export type { Logger };

/**
 * Inert library logger used when a host has not supplied a diagnostic sink.
 * Production composition roots can pass a real logger; importing parser and
 * contract modules therefore never creates process-global logging state.
 */
export function createNoopLogger(): Logger {
  return pino({ enabled: false });
}

export interface CreateLoggerOptions {
  readonly name?: string;
  readonly level?: pino.Level | pino.LevelWithSilent;
  readonly pretty?: boolean;
  readonly bindings?: Record<string, unknown>;
  /** Host-provided environment values used only for logger defaults. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional writable stream for hosts and tests that need captured output. */
  readonly _dest?: NodeJS.WritableStream;
}

function resolvePrettyDestination(): NodeJS.WritableStream | undefined {
  try {
    const prettyModule: unknown = loadOptionalModule(loadOptionalModule.resolve('pino-pretty'));
    return isPrettyFactory(prettyModule) ? prettyModule({ colorize: true }) : undefined;
  } catch {
    return undefined;
  }
}

function createPino(
  level: pino.LevelWithSilent,
  usePretty: boolean,
  dest?: NodeJS.WritableStream,
): Logger {
  const pinoOpts: LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (dest !== undefined) return pino(pinoOpts, dest);
  const pretty = usePretty ? resolvePrettyDestination() : undefined;
  return pretty === undefined ? pino(pinoOpts) : pino(pinoOpts, pretty);
}

export function createLogger(opts?: CreateLoggerOptions): Logger {
  const env = opts?.env ?? {};
  const level: pino.LevelWithSilent =
    opts?.level ?? (isLogLevel(env['LOG_LEVEL']) ? env['LOG_LEVEL'] : undefined) ?? 'info';

  // When a custom dest is provided (test-only), skip pretty so JSON goes directly to the stream.
  const usePretty =
    opts?._dest !== undefined
      ? false
      : opts?.pretty !== undefined
        ? opts.pretty
        : env['NODE_ENV'] !== 'production';

  // Generate a stable instanceId for root loggers; may throw NotImplemented in tests
  let instanceId: string;
  try {
    instanceId = v7();
  } catch {
    instanceId = randomUUID();
  }

  const baseBindings: Record<string, unknown> = {
    name: opts?.name ?? 'potemkin',
    instanceId,
    ...opts?.bindings,
  };

  return createPino(level, usePretty, opts?._dest).child(baseBindings);
}

export function childLogger(parent: Logger, bindings: Record<string, unknown>): Logger {
  return parent.child(bindings);
}
