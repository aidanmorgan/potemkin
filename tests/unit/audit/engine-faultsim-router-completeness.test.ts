/**
 * AUDIT: engine/faultSim.ts + engine/router.ts — completeness probing tests
 *
 * Verified behaviours → it(...)
 * Identified gaps    → it.failing(...)
 */

import { extractFaultSignal } from '../../../src/engine/faultSim';
import { translateIntent } from '../../../src/engine/router';
import { ContractViolationError } from '../../../src/errors';
import { makeBoundary } from '../_helpers';

// ── ROUTER: VERIFIED — method normalisation via toUpperCase ───────────────────

it('CONTRACT: translateIntent handles mixed-case method strings correctly (Get → query)', () => {
  // router.ts line 21: const upper = input.method.toUpperCase()
  expect(translateIntent({ method: 'Get', boundary: makeBoundary() })).toBe('query');
});

it('CONTRACT: translateIntent handles mixed-case POST (pOsT → creation with identity)', () => {
  const boundary = makeBoundary({ identity: { creation: { generate: '$uuidv7()' } } });
  expect(translateIntent({ method: 'pOsT', boundary })).toBe('creation');
});

it('CONTRACT: translateIntent handles mixed-case PUT (PuT → mutation)', () => {
  expect(translateIntent({ method: 'PuT', boundary: makeBoundary() })).toBe('mutation');
});

it('CONTRACT: translateIntent handles mixed-case PATCH (Patch → mutation)', () => {
  expect(translateIntent({ method: 'Patch', boundary: makeBoundary() })).toBe('mutation');
});

it('CONTRACT: translateIntent handles mixed-case DELETE (dElEtE → mutation)', () => {
  expect(translateIntent({ method: 'dElEtE', boundary: makeBoundary() })).toBe('mutation');
});

// ── ROUTER: AUDIT GAP — HEAD/OPTIONS not supported ────────────────────────────

it('CONTRACT: HEAD method throws ContractViolationError (not silently ignored)', () => {
  // Verify that unsupported methods throw, not return a default/silent value.
  expect(() =>
    translateIntent({ method: 'HEAD', boundary: makeBoundary() }),
  ).toThrow(ContractViolationError);
});

it('CONTRACT: ContractViolationError from unknown method includes method name in message', () => {
  try {
    translateIntent({ method: 'TRACE', boundary: makeBoundary() });
    fail('Expected ContractViolationError');
  } catch (e) {
    expect((e as Error).message).toContain('TRACE');
  }
});

// ── ROUTER: AUDIT GAP — POST with identity object but no creation key ─────────

it('CONTRACT: POST with identity={} (no creation key) returns mutation (not creation)', () => {
  // router.ts line 27: identity?.creation !== undefined → creation; otherwise mutation
  // An identity object with no creation property means the boundary supports mutations via POST.
  const boundary = makeBoundary({ identity: {} });
  expect(translateIntent({ method: 'POST', boundary })).toBe('mutation');
});

// ── FAULT SIM: VERIFIED — case-insensitive header lookup ─────────────────────

it('CONTRACT: x-specmatic-fault header is found case-insensitively (X-SPECMATIC-FAULT)', () => {
  const signal = extractFaultSignal({
    'X-SPECMATIC-FAULT': JSON.stringify({ status: 503, body: { error: 'down' } }),
  });
  expect(signal).not.toBeNull();
  expect(signal?.status).toBe(503);
});

it('CONTRACT: x-specmatic-fault header is found with mixed case (X-Specmatic-Fault)', () => {
  const signal = extractFaultSignal({
    'X-Specmatic-Fault': JSON.stringify({ status: 429, body: null }),
  });
  expect(signal?.status).toBe(429);
});

// ── FAULT SIM: VERIFIED — headers merged correctly ───────────────────────────

it('CONTRACT: fault signal headers are preserved in FaultSignal.headers', () => {
  const signal = extractFaultSignal({
    'x-specmatic-fault': JSON.stringify({
      status: 503,
      body: {},
      headers: { 'retry-after': '120', 'x-correlation-id': 'abc-123' },
    }),
  });

  expect(signal?.headers).toEqual({
    'retry-after': '120',
    'x-correlation-id': 'abc-123',
  });
});

it('CONTRACT: fault signal headers field with non-object value (array) is excluded', () => {
  // faultSim.ts lines 73-78: headers must be a non-array object or undefined
  const signal = extractFaultSignal({
    'x-specmatic-fault': JSON.stringify({
      status: 503,
      body: {},
      headers: ['not', 'an', 'object'],
    }),
  });

  expect(signal?.headers).toBeUndefined();
});

// ── FAULT SIM: AUDIT GAP — headers with null value ───────────────────────────

it.failing('AUDIT GAP: fault signal with headers: null — headers field is excluded but not validated as null', () => {
  // faultSim.ts line 73: headers !== undefined && typeof === object && !Array.isArray
  // If headers is null: typeof null === 'object' and !Array.isArray(null) is true.
  // So null would pass the type check and be returned as headers!
  // This is a shape validation gap: null is not a valid Record<string,string>.
  const signal = extractFaultSignal({
    'x-specmatic-fault': JSON.stringify({
      status: 503,
      body: {},
      headers: null,
    }),
  });

  // Expected: headers should be undefined (null is not a valid headers object)
  // Observed: null passes the typeof check and !Array.isArray(null) check → set as headers
  expect(signal?.headers).toBeUndefined(); // Will fail — actual value is null (cast to Record<string,string>)
});

// ── FAULT SIM: VERIFIED — body can be any JsonValue ──────────────────────────

it('CONTRACT: fault signal body can be an array', () => {
  const signal = extractFaultSignal({
    'x-specmatic-fault': JSON.stringify({ status: 200, body: [1, 2, 3] }),
  });
  expect(signal?.body).toEqual([1, 2, 3]);
});

it('CONTRACT: fault signal body can be a boolean', () => {
  const signal = extractFaultSignal({
    'x-specmatic-fault': JSON.stringify({ status: 200, body: false }),
  });
  expect(signal?.body).toBe(false);
});

it('CONTRACT: fault signal body can be a number', () => {
  const signal = extractFaultSignal({
    'x-specmatic-fault': JSON.stringify({ status: 200, body: 42 }),
  });
  expect(signal?.body).toBe(42);
});

// ── FAULT SIM: VERIFIED — strict shape validation ────────────────────────────

it('CONTRACT: parsed JSON that is a primitive (not object) throws ContractViolationError', () => {
  expect(() =>
    extractFaultSignal({
      'x-specmatic-fault': '"just a string"',
    }),
  ).toThrow(ContractViolationError);
});

it('CONTRACT: parsed JSON that is null throws ContractViolationError', () => {
  // faultSim.ts line 49: parsed === null → throw
  expect(() =>
    extractFaultSignal({
      'x-specmatic-fault': 'null',
    }),
  ).toThrow(ContractViolationError);
});

// ── FAULT SIM: AUDIT GAP — status must be a valid HTTP status code ─────────────

it.failing('AUDIT GAP: fault signal with status=-1 is accepted without validation (any number accepted)', () => {
  // faultSim.ts line 59: typeof obj['status'] !== 'number' → only type-checks, not range.
  // Negative or out-of-range HTTP status codes are accepted silently.
  // This means a fault signal can inject invalid HTTP status codes into the response.
  const signal = extractFaultSignal({
    'x-specmatic-fault': JSON.stringify({ status: -1, body: {} }),
  });

  // Expected: should throw ContractViolationError for invalid HTTP status
  // Observed: silently accepted, signal.status === -1
  expect(signal).toBeNull(); // Will fail — actual signal is not null
});
