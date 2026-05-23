import { CelPhase } from '../../../src/cel/phases';

describe('cel/phases', () => {
  it('has Behavior phase with value "behavior"', () => {
    expect(CelPhase.Behavior).toBe('behavior');
  });

  it('has EventHydration phase with value "event-hydration"', () => {
    expect(CelPhase.EventHydration).toBe('event-hydration');
  });

  it('has Reducer phase with value "reducer"', () => {
    expect(CelPhase.Reducer).toBe('reducer');
  });

  it('phases are distinct strings', () => {
    const phases = new Set([CelPhase.Behavior, CelPhase.EventHydration, CelPhase.Reducer]);
    expect(phases.size).toBe(3);
  });

  it('Behavior is enumerable via Object.values', () => {
    const values = Object.values(CelPhase);
    expect(values).toContain('behavior');
    expect(values).toContain('event-hydration');
    expect(values).toContain('reducer');
  });
});
