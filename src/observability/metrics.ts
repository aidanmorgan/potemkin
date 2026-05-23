import { metrics } from '@opentelemetry/api';
import type { Meter, Counter, Histogram } from '@opentelemetry/api';

export type { Meter, Counter, Histogram };

export interface EngineMetrics {
  readonly commandsTotal: Counter;
  readonly commandDurationMs: Histogram;
  readonly eventsAppendedTotal: Counter;
  readonly uowAbortsTotal: Counter;
  readonly faultsSimulatedTotal: Counter;
}

export function createEngineMetrics(meter?: Meter): EngineMetrics {
  const m: Meter = meter ?? metrics.getMeter('specmatic-stateful-sim');

  return {
    commandsTotal: m.createCounter('engine.commands.total', {
      description: 'Total number of commands processed by the engine.',
    }),
    commandDurationMs: m.createHistogram('engine.command.duration_ms', {
      description: 'Histogram of command processing duration in milliseconds.',
      unit: 'ms',
    }),
    eventsAppendedTotal: m.createCounter('engine.events_appended.total', {
      description: 'Total number of domain events appended to the event log.',
    }),
    uowAbortsTotal: m.createCounter('engine.uow_aborts.total', {
      description: 'Total number of Unit of Work transactions aborted.',
    }),
    faultsSimulatedTotal: m.createCounter('engine.faults_simulated.total', {
      description: 'Total number of fault-simulation signals triggered.',
    }),
  };
}
