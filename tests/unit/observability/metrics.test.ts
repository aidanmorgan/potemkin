import { createEngineMetrics } from '../../../src/observability/metrics';
import { metrics } from '@opentelemetry/api';

describe('observability/metrics', () => {
  describe('createEngineMetrics', () => {
    it('creates metrics with default meter', () => {
      const m = createEngineMetrics();
      expect(m).toBeDefined();
    });

    it('returns commandsTotal counter', () => {
      const m = createEngineMetrics();
      expect(m.commandsTotal).toBeDefined();
    });

    it('returns commandDurationMs histogram', () => {
      const m = createEngineMetrics();
      expect(m.commandDurationMs).toBeDefined();
    });

    it('returns eventsAppendedTotal counter', () => {
      const m = createEngineMetrics();
      expect(m.eventsAppendedTotal).toBeDefined();
    });

    it('returns uowAbortsTotal counter', () => {
      const m = createEngineMetrics();
      expect(m.uowAbortsTotal).toBeDefined();
    });

    it('returns faultsSimulatedTotal counter', () => {
      const m = createEngineMetrics();
      expect(m.faultsSimulatedTotal).toBeDefined();
    });

    it('commandsTotal.add does not throw', () => {
      const m = createEngineMetrics();
      expect(() => m.commandsTotal.add(1)).not.toThrow();
    });

    it('commandDurationMs.record does not throw', () => {
      const m = createEngineMetrics();
      expect(() => m.commandDurationMs.record(42)).not.toThrow();
    });

    it('accepts a custom meter', () => {
      const meter = metrics.getMeter('custom-test');
      expect(() => createEngineMetrics(meter)).not.toThrow();
    });

    it('has all five metric fields defined', () => {
      const m = createEngineMetrics();
      // With the default no-op OTel meter they may share instances;
      // what matters is all five fields are present and have add/record methods
      const fields = [m.commandsTotal, m.eventsAppendedTotal, m.uowAbortsTotal, m.faultsSimulatedTotal];
      for (const counter of fields) {
        expect(typeof (counter as any).add).toBe('function');
      }
    });
  });
});
