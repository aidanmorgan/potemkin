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

// Shared root pino instance. Constructing a new pino with a transport on every
// createLogger() call leaked process exit listeners — each transport stream
// registers its own — and triggered MaxListenersExceededWarning under test load.
// A single shared root with .child() bindings produces identical output without
// the leak.
let _rootPino: Logger | undefined;
function getRootPino(level: pino.LevelWithSilent, usePretty: boolean): Logger {
  if (_rootPino) return _rootPino;
  const transport = usePretty ? resolvePrettyTransport() : undefined;
  const pinoOpts: LoggerOptions = {
    level: level as string,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport,
  };
  _rootPino = pino(pinoOpts);
  return _rootPino;
}

export function createLogger(opts?: CreateLoggerOptions): Logger {
  const level: pino.LevelWithSilent =
    (opts?.level ?? (process.env['LOG_LEVEL'] as pino.LevelWithSilent | undefined)) ?? 'info';

  const usePretty =
    opts?.pretty !== undefined
      ? opts.pretty
      : process.env['NODE_ENV'] !== 'production';

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

  return getRootPino(level, usePretty).child(baseBindings);
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
