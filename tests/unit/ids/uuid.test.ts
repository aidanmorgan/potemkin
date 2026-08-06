import { validate, v7, version } from 'uuid';

describe('uuid dependency', () => {
  it('generates valid UUIDv7 values through the dependency API', () => {
    const id = v7();

    expect(validate(id)).toBe(true);
    expect(version(id)).toBe(7);
  });

  it('generates distinct, ordered values on successive calls', () => {
    const ids = Array.from({ length: 20 }, () => v7());

    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 1; index < ids.length; index++) {
      expect(ids[index]! >= ids[index - 1]!).toBe(true);
    }
  });

  it('validates canonical UUIDs and rejects other versions or malformed values', () => {
    expect(validate('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(version('550e8400-e29b-41d4-a716-446655440000')).toBe(4);
    expect(validate('not-a-uuid')).toBe(false);
    expect(validate('{550e8400-e29b-41d4-a716-446655440000}')).toBe(false);
  });

  it('supports reproducible UUIDv7 options without project-owned encoding', () => {
    const random = new Uint8Array(16).fill(0x42);
    const options = { msecs: 0, seq: 42, random };

    expect(v7(options)).toBe(v7({ ...options, random: new Uint8Array(random) }));
    expect(version(v7(options))).toBe(7);
  });
});
