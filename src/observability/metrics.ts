import { metrics } from "@opentelemetry/api";
import type { Meter, Counter, Histogram, Attributes } from "@opentelemetry/api";

export type { Meter, Counter, Histogram };

export interface EngineMetrics {
  readonly commandsTotal: Counter;
  readonly commandDurationMs: Histogram;
  readonly eventsAppendedTotal: Counter;
  readonly uowAbortsTotal: Counter;
  readonly faultsSimulatedTotal: Counter;
}

export type RuntimeMetricObserver = (
  name: string,
  value?: number,
  fields?: Readonly<Record<string, string>>,
) => void;

/**
 * Connect the source-neutral runtime metric port to OpenTelemetry counters.
 *
 * Runtime metric names are deliberately created lazily: the engine can add a
 * well-named outcome without making the model or either authoring compiler
 * depend on an OpenTelemetry implementation. Every observation uses a
 * counter, because the runtime port represents event counts rather than
 * gauges or distributions.
 */
export function createRuntimeOtelMetricObserver(meter?: Meter): RuntimeMetricObserver {
  const activeMeter = meter ?? metrics.getMeter("potemkin");
  const counters = new Map<string, Counter>();
  return (name, value = 1, fields) => {
    let counter = counters.get(name);
    if (counter === undefined) {
      counter = activeMeter.createCounter(name, {
        description: `Potemkin runtime metric ${name}.`,
      });
      counters.set(name, counter);
    }
    counter.add(value, fields as Attributes | undefined);
  };
}

export function createEngineMetrics(meter?: Meter): EngineMetrics {
  const m: Meter = meter ?? metrics.getMeter("potemkin");

  return {
    commandsTotal: m.createCounter("engine.commands.total", {
      description: "Total number of commands processed by the engine.",
    }),
    commandDurationMs: m.createHistogram("engine.command.duration_ms", {
      description: "Histogram of command processing duration in milliseconds.",
      unit: "ms",
    }),
    eventsAppendedTotal: m.createCounter("engine.events_appended.total", {
      description: "Total number of domain events appended to the event log.",
    }),
    uowAbortsTotal: m.createCounter("engine.uow_aborts.total", {
      description: "Total number of Unit of Work transactions aborted.",
    }),
    faultsSimulatedTotal: m.createCounter("engine.faults_simulated.total", {
      description: "Total number of fault-simulation signals triggered.",
    }),
  };
}
