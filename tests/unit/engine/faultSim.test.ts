import { extractFaultSignal } from '../../../src/engine/faultSim';
import { ContractViolationError } from '../../../src/errors';

describe('engine/faultSim', () => {
  describe('extractFaultSignal', () => {
    it('returns null when header is absent', () => {
      expect(extractFaultSignal({})).toBeNull();
    });

    it('returns null when header value is empty string', () => {
      expect(extractFaultSignal({ 'x-specmatic-fault': '' })).toBeNull();
    });

    it('parses a valid fault signal', () => {
      const signal = extractFaultSignal({
        'x-specmatic-fault': JSON.stringify({ status: 503, body: { error: 'unavailable' } }),
      });
      expect(signal).not.toBeNull();
      expect(signal?.status).toBe(503);
      expect(signal?.body).toEqual({ error: 'unavailable' });
    });

    it('is case-insensitive for header key', () => {
      const signal = extractFaultSignal({
        'X-Specmatic-Fault': JSON.stringify({ status: 500, body: {} }),
      });
      expect(signal).not.toBeNull();
      expect(signal?.status).toBe(500);
    });

    it('parses headers when provided', () => {
      const signal = extractFaultSignal({
        'x-specmatic-fault': JSON.stringify({
          status: 503,
          body: {},
          headers: { 'retry-after': '60' },
        }),
      });
      expect(signal?.headers).toEqual({ 'retry-after': '60' });
    });

    it('headers is undefined when not provided in payload', () => {
      const signal = extractFaultSignal({
        'x-specmatic-fault': JSON.stringify({ status: 503, body: {} }),
      });
      expect(signal?.headers).toBeUndefined();
    });

    it('throws ContractViolationError for invalid JSON', () => {
      expect(() =>
        extractFaultSignal({ 'x-specmatic-fault': 'not-json' }),
      ).toThrow(ContractViolationError);
    });

    it('throws ContractViolationError when status is missing', () => {
      expect(() =>
        extractFaultSignal({
          'x-specmatic-fault': JSON.stringify({ body: {} }),
        }),
      ).toThrow(ContractViolationError);
    });

    it('throws ContractViolationError when body is missing', () => {
      expect(() =>
        extractFaultSignal({
          'x-specmatic-fault': JSON.stringify({ status: 503 }),
        }),
      ).toThrow(ContractViolationError);
    });

    it('throws ContractViolationError when status is a string', () => {
      expect(() =>
        extractFaultSignal({
          'x-specmatic-fault': JSON.stringify({ status: '503', body: {} }),
        }),
      ).toThrow(ContractViolationError);
    });

    it('throws ContractViolationError when value is an array', () => {
      expect(() =>
        extractFaultSignal({
          'x-specmatic-fault': JSON.stringify([{ status: 503, body: {} }]),
        }),
      ).toThrow(ContractViolationError);
    });

    it('handles array header value (takes first element)', () => {
      const signal = extractFaultSignal({
        'x-specmatic-fault': [JSON.stringify({ status: 500, body: 'fault' })],
      } as any);
      expect(signal?.status).toBe(500);
    });

    it('body can be a string', () => {
      const signal = extractFaultSignal({
        'x-specmatic-fault': JSON.stringify({ status: 400, body: 'bad request' }),
      });
      expect(signal?.body).toBe('bad request');
    });

    it('body can be null', () => {
      const signal = extractFaultSignal({
        'x-specmatic-fault': JSON.stringify({ status: 204, body: null }),
      });
      expect(signal?.body).toBeNull();
    });

    it('throws ContractViolationError when status is above 599 (e.g. 999)', () => {
      expect(() =>
        extractFaultSignal({
          'x-specmatic-fault': JSON.stringify({ status: 999, body: {} }),
        }),
      ).toThrow(ContractViolationError);
    });

    it('throws ContractViolationError when status is 600 (boundary above range)', () => {
      expect(() =>
        extractFaultSignal({
          'x-specmatic-fault': JSON.stringify({ status: 600, body: {} }),
        }),
      ).toThrow(ContractViolationError);
    });

    it('throws ContractViolationError when status is below 100 (e.g. 99)', () => {
      expect(() =>
        extractFaultSignal({
          'x-specmatic-fault': JSON.stringify({ status: 99, body: {} }),
        }),
      ).toThrow(ContractViolationError);
    });

    it('accepts a valid status of 503 without throwing', () => {
      const signal = extractFaultSignal({
        'x-specmatic-fault': JSON.stringify({ status: 503, body: { error: 'down' } }),
      });
      expect(signal?.status).toBe(503);
    });
  });
});
