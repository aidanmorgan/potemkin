/**
 * Typed deterministic data generation for direct TypeScript authoring.
 *
 * The generator exposes typed categories as ordinary functions and can be
 * rebuilt around a request-local random source.
 */

import type { DataGenerator } from '../contracts/data.js';

const FIRST_NAMES = [
  'Alex',
  'Jordan',
  'Sam',
  'Taylor',
  'Casey',
  'Morgan',
  'Riley',
  'Quinn',
  'Avery',
  'Drew',
] as const;
const LAST_NAMES = [
  'Smith',
  'Jones',
  'Brown',
  'Taylor',
  'Wilson',
  'Davies',
  'Evans',
  'Robinson',
  'Walker',
  'Wright',
] as const;
const EMAIL_DOMAINS = ['example.com', 'test.org', 'fake.net'] as const;
const COMPANY_PREFIXES = ['Apex', 'BlueSky', 'Cornerstone', 'Delta', 'Echo', 'Foxtrot'] as const;
const COMPANY_SUFFIXES = ['Solutions', 'Systems', 'Holdings', 'Group', 'Industries'] as const;
const CITIES = ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Hobart'] as const;
const STREET_NAMES = ['George', 'King', 'Queen', 'High', 'Main'] as const;
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MULBERRY32_INCREMENT = 1831565813;

/** Stable string-to-state conversion shared by all runtime data providers. */
export function runtimeSeedHash(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** The request-local PRNG used by both direct callbacks and parsed expressions. */
export function createSeededRandom(seed: string): () => number {
  let state = runtimeSeedHash(seed);
  return () => {
    state = (state + MULBERRY32_INCREMENT) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function boundedRandom(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 0.9999999999)) : 0;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(boundedRandom(random) * values.length)]!;
}

function digits(random: () => number, length: number): string {
  return Array.from({ length }, () => String(Math.floor(boundedRandom(random) * 10))).join('');
}

function alphanumeric(random: () => number, length: number): string {
  return Array.from(
    { length },
    () => ALPHANUMERIC[Math.floor(boundedRandom(random) * ALPHANUMERIC.length)]!,
  ).join('');
}

function uuid(random: () => number): string {
  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(boundedRandom(random) * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(random, ['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
}

function date(random: () => number): Date {
  const start = Date.UTC(2000, 0, 1);
  const end = Date.UTC(2050, 0, 1);
  return new Date(start + Math.floor(boundedRandom(random) * (end - start)));
}

export function createRuntimeDataGenerator(random: () => number): DataGenerator {
  const person = {
    firstName: () => pick(random, FIRST_NAMES),
    lastName: () => pick(random, LAST_NAMES),
    fullName: () => `${pick(random, FIRST_NAMES)} ${pick(random, LAST_NAMES)}`,
  };
  const internet = {
    email: () => `${alphanumeric(random, 8).toLowerCase()}@${pick(random, EMAIL_DOMAINS)}`,
    url: () =>
      `https://${alphanumeric(random, 6).toLowerCase()}.example.com/${alphanumeric(random, 4).toLowerCase()}`,
    domainName: () => `${alphanumeric(random, 6).toLowerCase()}.example.com`,
  };
  const phone = {
    number: () => `+61 ${digits(random, 1)} ${digits(random, 4)} ${digits(random, 4)}`,
  };
  const company = {
    name: () => `${pick(random, COMPANY_PREFIXES)} ${pick(random, COMPANY_SUFFIXES)}`,
  };
  const address = {
    city: () => pick(random, CITIES),
    streetAddress: () =>
      `${Math.floor(boundedRandom(random) * 999) + 1} ${pick(random, STREET_NAMES)} St`,
  };
  const generator: DataGenerator = {
    person,
    internet,
    phone,
    company,
    address,
    fromFormat: (format) => {
      switch (format) {
        case 'email':
          return internet.email();
        case 'uuid':
          return uuid(random);
        case 'date':
          return date(random).toISOString().slice(0, 10);
        case 'date-time':
          return date(random).toISOString();
        case 'uri':
        case 'url':
          return internet.url();
        case 'hostname':
          return internet.domainName();
        case 'ipv4':
          return `${Math.floor(boundedRandom(random) * 256)}.${Math.floor(boundedRandom(random) * 256)}.${Math.floor(boundedRandom(random) * 256)}.${Math.floor(boundedRandom(random) * 256)}`;
        case 'string':
          return alphanumeric(random, 10);
      }
    },
    withRandom: (source) => createRuntimeDataGenerator(source),
  };
  return generator;
}
