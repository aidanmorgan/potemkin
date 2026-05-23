import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';
import { nextUuidv7 } from '../ids/uuidv7.js';

export type { Logger };

export interface CreateLoggerOptions {
  readonly name?: string;
  readonly level?: pino.Level | pino.LevelWithSilent;
  readonly pretty?: boolean;
  readonly bindings?: Record<string, unknown>;
}

function resolvePrettyTransport(): LoggerOptions['transport'] {
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true } };
  } catch {
    return undefined;
  }
}

export function createLogger(opts?: CreateLoggerOptions): Logger {
  const level: pino.LevelWithSilent =
    (opts?.level ?? (process.env['LOG_LEVEL'] as pino.LevelWithSilent | undefined)) ?? 'info';

  const usePretty =
    opts?.pretty !== undefined
      ? opts.pretty
      : process.env['NODE_ENV'] !== 'production';

  const transport = usePretty ? resolvePrettyTransport() : undefined;

  // Generate a stable instanceId for root loggers; may throw NotImplemented in tests
  let instanceId: string;
  try {
    instanceId = nextUuidv7();
  } catch {
    instanceId = 'not-implemented';
  }

  const baseBindings: Record<string, unknown> = {
    name: opts?.name ?? 'specmatic-stateful-sim',
    instanceId,
    ...opts?.bindings,
  };

  const pinoOpts: LoggerOptions = {
    level: level as string,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport,
  };

  return pino(pinoOpts).child(baseBindings);
}

let _rootLogger: Logger | undefined;

export function rootLogger(): Logger {
  if (!_rootLogger) {
    _rootLogger = createLogger();
  }
  return _rootLogger;
}

export function childLogger(parent: Logger, bindings: Record<string, unknown>): Logger {
  return parent.child(bindings);
}
