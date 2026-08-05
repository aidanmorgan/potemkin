import { createRuntimeDataGenerator, runtimeSeedHash } from '../../../src/model/data.js';

describe('source-independent runtime data generator', () => {
  it('provides deterministic typed data for every supported format', () => {
    const first = createRuntimeDataGenerator(() => 0.25);
    const second = createRuntimeDataGenerator(() => 0.25);

    expect(runtimeSeedHash('orders')).toBe(runtimeSeedHash('orders'));
    expect(first.person.firstName()).toBe(second.person.firstName());
    expect(first.person.lastName()).toBe(second.person.lastName());
    expect(first.person.fullName()).toMatch(/\w+ \w+/);
    expect(first.internet.email()).toMatch(/^[a-z0-9]+@(example\.com|test\.org|fake\.net)$/);
    expect(first.internet.url()).toMatch(/^https:\/\/[a-z0-9]+\.example\.com\/[a-z0-9]+$/);
    expect(first.internet.domainName()).toMatch(/^[a-z0-9]+\.example\.com$/);
    expect(first.phone.number()).toMatch(/^\+61 \d \d{4} \d{4}$/);
    expect(first.company.name()).toMatch(/^\w+ \w+$/);
    expect(first.address.city()).toMatch(/^[A-Z][a-z]+$/);
    expect(first.address.streetAddress()).toMatch(/^\d+ \w+ St$/);

    expect(first.fromFormat('email')).toMatch(/@/);
    expect(first.fromFormat('uuid')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.fromFormat('date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.fromFormat('date-time')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.fromFormat('uri')).toMatch(/^https:\/\//);
    expect(first.fromFormat('url')).toMatch(/^https:\/\//);
    expect(first.fromFormat('hostname')).toMatch(/\.example\.com$/);
    expect(first.fromFormat('ipv4')).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/);
    expect(first.fromFormat('string')).toHaveLength(10);
  });

  it('bounds hostile random sources and supports request-local replacement', () => {
    const values = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1];
    const generator = createRuntimeDataGenerator(() => values.shift() ?? 0);

    expect(generator.internet.email()).toMatch(/@/);
    expect(generator.address.streetAddress()).toMatch(/^\d+ /);
    expect(createRuntimeDataGenerator(() => 1).fromFormat('ipv4')).toBe('255.255.255.255');

    const replacement = generator.withRandom(() => 0);
    expect(replacement.person.firstName()).toBe('Alex');
    expect(replacement.fromFormat('uuid')).toMatch(/^00000000-0000-4000-8/);
  });

  it('creates stable seeded sequences', () => {
    const left = createRuntimeDataGenerator(
      (() => {
        let next = 0;
        return () => next++ / 100;
      })(),
    );
    const right = createRuntimeDataGenerator(
      (() => {
        let next = 0;
        return () => next++ / 100;
      })(),
    );

    expect([
      left.person.firstName(),
      left.fromFormat('uuid'),
      left.fromFormat('date-time'),
    ]).toEqual([right.person.firstName(), right.fromFormat('uuid'), right.fromFormat('date-time')]);
  });
});
