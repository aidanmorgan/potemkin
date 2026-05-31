import {
  validateWorkflowForward,
  validateGovernanceForward,
  translateOverlayPatches,
  mergeForwardBlock,
} from '../../../src/dsl/forwardBlocks.js';

describe('validateWorkflowForward', () => {
  it('accepts a well-formed workflow block', () => {
    const out = validateWorkflowForward({
      ids: {
        leadId: { extract: '$.response.body.id', use: '$.request.path.leadId' },
      },
    });
    expect(out.ids['leadId']).toEqual({
      extract: '$.response.body.id',
      use: '$.request.path.leadId',
    });
  });

  it('throws when an id entry is missing extract or use', () => {
    expect(() =>
      validateWorkflowForward({ ids: { x: { extract: 'a' } } }),
    ).toThrow(/workflow.ids.x.use/);
  });

  it('throws when ids is missing entirely', () => {
    expect(() => validateWorkflowForward({})).toThrow(/workflow.ids/);
  });
});

describe('validateGovernanceForward', () => {
  it('accepts report + successCriterion', () => {
    const out = validateGovernanceForward({
      report: { successCriteria: { minCoverage: 80 } },
      successCriterion: 'minCoverage',
    });
    expect(out.successCriterion).toBe('minCoverage');
  });

  it('throws when report is the wrong type', () => {
    expect(() => validateGovernanceForward({ report: 'oops' })).toThrow(/governance.report/);
  });
});

describe('translateOverlayPatches', () => {
  it('translates add/replace → update', () => {
    expect(
      translateOverlayPatches([
        { op: 'add', path: '/paths/~1leads/post/x-rate-limit', value: 100 },
        { op: 'replace', path: '/paths/~1leads/get/deprecated', value: true },
      ]),
    ).toEqual([
      { target: '$.paths./leads.post.x-rate-limit', update: 100 },
      { target: '$.paths./leads.get.deprecated', update: true },
    ]);
  });

  it('translates remove', () => {
    expect(translateOverlayPatches([{ op: 'remove', path: '/components/schemas/Lead' }])).toEqual([
      { target: '$.components.schemas.Lead', remove: true },
    ]);
  });

  it('rejects move because the source value is unavailable without the spec', () => {
    expect(() =>
      translateOverlayPatches([{ op: 'move', from: '/a/b', path: '/c/d' }]),
    ).toThrow(/cannot be translated without the source spec/);
  });

  it('rejects copy because the source value is unavailable without the spec', () => {
    expect(() =>
      translateOverlayPatches([{ op: 'copy', from: '/a/b', path: '/c/d' }]),
    ).toThrow(/cannot be translated without the source spec/);
  });

  it('rejects Potemkin extension ops', () => {
    expect(() =>
      translateOverlayPatches([{ op: 'increment', path: '/x', by: 1 }]),
    ).toThrow(/Overlay translation/);
  });
});

describe('mergeForwardBlock (REQ-FWD-001 precedence)', () => {
  it('scalars from potemkin replace specmatic scalars', () => {
    expect(
      mergeForwardBlock({ name: 'spec', timeout: 1 }, { timeout: 5 }),
    ).toEqual({ name: 'spec', timeout: 5 });
  });

  it('lists concatenate (specmatic first, potemkin after)', () => {
    expect(
      mergeForwardBlock({ items: ['a', 'b'] }, { items: ['c'] }),
    ).toEqual({ items: ['a', 'b', 'c'] });
  });

  it('nested objects merge recursively', () => {
    expect(
      mergeForwardBlock<Record<string, unknown>>(
        { auth: { mode: 'jwt', issuer: 'a' } },
        { auth: { issuer: 'b', audience: 'x' } },
      ),
    ).toEqual({ auth: { mode: 'jwt', issuer: 'b', audience: 'x' } });
  });

  it('handles missing operands', () => {
    expect(mergeForwardBlock(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeForwardBlock({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeForwardBlock(undefined, undefined)).toEqual({});
  });
});
