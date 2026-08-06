import * as fc from 'fast-check';
import { validate, v7, version } from 'uuid';

const RUN_COUNT = 200;
const SEED = 42;

describe('uuid dependency properties', () => {
  it('always produces valid UUIDv7 values', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), () => {
        const id = v7();
        expect(validate(id)).toBe(true);
        expect(version(id)).toBe(7);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('keeps UUIDv7 timestamps non-decreasing across a sequence', () => {
    const ids = Array.from({ length: 1000 }, () => v7());

    for (let index = 1; index < ids.length; index++) {
      const previousTimestamp = ids[index - 1]!.slice(0, 8) + ids[index - 1]!.slice(9, 13);
      const currentTimestamp = ids[index]!.slice(0, 8) + ids[index]!.slice(9, 13);
      expect(currentTimestamp >= previousTimestamp).toBe(true);
    }
  });
});
