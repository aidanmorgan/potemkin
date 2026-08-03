import { createRuntimeDataGenerator, createSeededRandom } from "../model/data.js";
import type { RuntimeClock, RuntimeHelpers } from "../model/runtime.js";
import type { RuntimeTimerScheduler } from "./ports.js";
import { ConfigurationError } from "../errors.js";
import { createDeterministicUuidv7Source, nextUuidv7 } from "../ids/uuidv7.js";

/** Host-owned services required to boot a source-independent runtime. */
export interface RuntimeHostServices {
  readonly helpers: RuntimeHelpers;
  readonly clock: RuntimeClock;
  readonly sessionToken: () => string;
  /** Runtime timer port; stateful stores never reach for process timers directly. */
  readonly timers: RuntimeTimerScheduler;
  /** Runtime delay port used by latency and lifecycle execution. */
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/**
 * Create the production host services used when an embedding host does not
 * provide deterministic replacements. This is a composition-root factory;
 * the runtime itself only consumes the returned ports.
 */
export function createDefaultRuntimeHost(): RuntimeHostServices {
  const random = () => Math.random();
  const helpers: RuntimeHelpers = {
    now: () => new Date().toISOString(),
    uuid: nextUuidv7,
    random,
    data: createRuntimeDataGenerator(random),
    clone,
  };
  return {
    helpers,
    clock: createWallClock(),
    sessionToken: () => createSessionToken(helpers.random),
    timers: createRuntimeTimers(),
    sleep: runtimeSleep,
  };
}

export interface DeterministicRuntimeHostOptions {
  /** Fixed timestamp used as the beginning of the host's virtual clock. */
  readonly epochMs?: number;
  /** Seed for non-UUID helper randomness and generated session tokens. */
  readonly randomSeed?: string;
  /** Initial value of the one UUID counter shared by this host. */
  readonly uuidSeedIndex?: number;
}

/**
 * Create a reproducible host for bounded tools such as example export.
 *
 * Every runtime UUID mint goes through the returned helper source, while the
 * clock and other helper randomness are also owned by this host. No process
 * global mode is changed.
 */
export function createDeterministicRuntimeHost(
  options: DeterministicRuntimeHostOptions = {},
): RuntimeHostServices {
  const epochMs = options.epochMs ?? 0;
  if (!Number.isFinite(epochMs)) {
    throw new ConfigurationError("Deterministic host epoch must be finite", {
      field: "runtimeHost.epochMs",
    });
  }
  const random = createSeededRandom(options.randomSeed ?? "potemkin-deterministic-host");
  const uuid = createDeterministicUuidv7Source(options.uuidSeedIndex ?? 0);
  const clock = createFixedClock(epochMs);
  const helpers: RuntimeHelpers = {
    now: () => new Date(clock.nowMs()).toISOString(),
    uuid,
    random,
    data: createRuntimeDataGenerator(random),
    clone,
  };
  return {
    helpers,
    clock,
    sessionToken: () => createSessionToken(random),
    timers: createRuntimeTimers(),
    sleep: runtimeSleep,
  };
}

function createRuntimeTimers(): RuntimeTimerScheduler {
  return {
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    unref: (handle) => (handle as NodeJS.Timeout).unref(),
  };
}

function runtimeSleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

function createSessionToken(random: () => number): string {
  const alphabet = "0123456789abcdef";
  return Array.from({ length: 64 }, () => alphabet[Math.floor(random() * alphabet.length)]!).join(
    "",
  );
}

function createWallClock(): RuntimeClock {
  let offset = 0;
  return {
    nowMs: () => Date.now() + offset,
    offsetMs: () => offset,
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds))
        throw new ConfigurationError("Clock advance must be finite", {
          field: "clock.advance",
        });
      offset += milliseconds;
      return offset;
    },
    reset: () => {
      offset = 0;
    },
  };
}

function createFixedClock(epochMs: number): RuntimeClock {
  let offset = 0;
  return {
    nowMs: () => epochMs + offset,
    offsetMs: () => offset,
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds))
        throw new ConfigurationError("Clock advance must be finite", {
          field: "clock.advance",
        });
      offset += milliseconds;
      return offset;
    },
    reset: () => {
      offset = 0;
    },
  };
}
