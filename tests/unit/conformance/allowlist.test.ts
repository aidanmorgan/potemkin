import {
  assertAllowlistIsUnique,
  evaluateAllowlist,
  parseAllowlistDocument,
  selectAllowlist,
} from '../../../src/conformance/allowlist';
import type { ConformanceFailure } from '../../../src/conformance/types';

const failure: ConformanceFailure = {
  testName: 'read unknown lead',
  message: 'status mismatch',
  details: '',
  method: 'GET',
  path: '/leads/{id}',
  scenario: 'read unknown lead',
  expectedStatus: '200',
  actualStatus: '404',
};

describe('Specmatic conformance allowlists', () => {
  it('supports named allowlists and matches the complete case key', () => {
    const allowlists = parseAllowlistDocument({
      version: 1,
      allowlists: [
        {
          name: 'crm-layer-c',
          entries: [
            {
              id: 'unknown-lead',
              method: 'get',
              path: '/leads/{id}',
              scenario: 'read unknown lead',
              expected_status: 200,
              actual_status: 404,
              reason: 'An unseeded id is a valid stateful 404.',
            },
          ],
        },
      ],
    });
    const selected = selectAllowlist(allowlists, 'crm-layer-c');
    expect(selected?.name).toBe('crm-layer-c');
    expect(evaluateAllowlist([failure], selected)).toMatchObject({
      allowed: [failure],
      unexpected: [],
      stale: [],
    });
  });

  it('reports stale entries when a previously observed divergence disappears', () => {
    const allowlist = parseAllowlistDocument({
      version: 1,
      name: 'crm-layer-c',
      entries: [
        {
          id: 'unknown-lead',
          method: 'GET',
          path: '/leads/{id}',
          scenario: 'read unknown lead',
          expected_status: 200,
          actual_status: 404,
          reason: 'stateful divergence',
        },
      ],
    })[0];
    expect(evaluateAllowlist([], allowlist).stale.map((entry) => entry.id)).toEqual([
      'unknown-lead',
    ]);
  });

  it('rejects duplicate ids so entries cannot silently shadow each other', () => {
    const allowlist = parseAllowlistDocument({
      version: 1,
      name: 'duplicate',
      entries: [
        {
          id: 'same',
          method: 'GET',
          path: '/a',
          scenario: 'a',
          expected_status: 200,
          actual_status: 404,
          reason: 'one',
        },
        {
          id: 'same',
          method: 'GET',
          path: '/b',
          scenario: 'b',
          expected_status: 200,
          actual_status: 404,
          reason: 'two',
        },
      ],
    })[0];
    expect(() => assertAllowlistIsUnique(allowlist)).toThrow("duplicate entry id 'same'");
  });

  it('consumes each matching entry once instead of allowing an unbounded duplicate', () => {
    const allowlist = parseAllowlistDocument({
      version: 1,
      name: 'single-use',
      entries: [
        {
          id: 'one',
          method: 'GET',
          path: '/leads/{id}',
          scenario: 'read unknown lead',
          expected_status: 200,
          actual_status: 404,
          reason: 'one observed divergence',
        },
      ],
    })[0];
    const evaluation = evaluateAllowlist([failure, failure], allowlist);
    expect(evaluation.allowed).toHaveLength(1);
    expect(evaluation.unexpected).toHaveLength(1);
    expect(evaluation.stale).toEqual([]);
  });

  it('rejects duplicate named allowlists instead of selecting the first one silently', () => {
    expect(() =>
      parseAllowlistDocument({
        version: 1,
        allowlists: [
          { name: 'crm', entries: [] },
          { name: 'crm', entries: [] },
        ],
      }),
    ).toThrow("duplicate name 'crm'");
  });
});
