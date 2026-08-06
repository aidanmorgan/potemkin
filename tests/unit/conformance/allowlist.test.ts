import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertAllowlistIsUnique,
  evaluateAllowlist,
  loadAllowlists,
  parseAllowlistDocument,
  selectAllowlist,
} from '../../../src/conformance/allowlist';
import {
  toConformanceFilePath,
  toConformanceReportId,
  type ConformanceFailure,
} from '../../../src/conformance/types';

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
  it('loads YAML anchors and merge keys with the same allowlist shape', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'potemkin-allowlist-'));
    const filePath = path.join(directory, 'allowlist.yaml');
    await writeFile(
      filePath,
      `version: 1
name: crm
entry_defaults: &entry_defaults
  method: GET
  scenario: read unknown lead
  expected_status: 200
  actual_status: 404
  reason: an unseeded id is a valid stateful 404
entries:
  - <<: *entry_defaults
    id: unknown-lead
    path: /leads/{id}
`,
    );

    try {
      await expect(loadAllowlists(filePath)).resolves.toEqual([
        {
          name: 'crm',
          entries: [
            {
              id: 'unknown-lead',
              method: 'GET',
              path: '/leads/{id}',
              scenario: 'read unknown lead',
              expectedStatus: '200',
              actualStatus: '404',
              reason: 'an unseeded id is a valid stateful 404',
            },
          ],
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed YAML while loading an allowlist', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'potemkin-allowlist-'));
    const filePath = path.join(directory, 'allowlist.yaml');
    await writeFile(filePath, 'version: [1\n');

    try {
      await expect(loadAllowlists(filePath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it('uses canonical constructors to normalize allowlist case fields', () => {
    const [allowlist] = parseAllowlistDocument({
      version: 1,
      name: 'normalized',
      entries: [
        {
          id: 'normalized-case',
          method: ' post ',
          path: ' /leads/{id} ',
          scenario: 'read unknown lead',
          expected_status: ' 200 ',
          actual_status: 404,
          reason: 'normalized identity',
        },
      ],
    });

    expect(allowlist?.entries).toEqual([
      {
        id: 'normalized-case',
        method: 'POST',
        path: '/leads/{id}',
        scenario: 'read unknown lead',
        expectedStatus: '200',
        actualStatus: '404',
        reason: 'normalized identity',
      },
    ]);
  });

  it('returns normalized file paths and report identifiers', () => {
    expect(toConformanceFilePath('  reports/specmatic.xml  ')).toBe('reports/specmatic.xml');
    expect(toConformanceReportId('  testcase-42  ')).toBe('testcase-42');
    expect(() => toConformanceFilePath(' \t ')).toThrow('Conformance file path must not be empty');
    expect(() => toConformanceReportId(' \t ')).toThrow(
      'Conformance report identifier must not be empty',
    );
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
