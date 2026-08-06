import { validateForwardedResponse } from '../../../src/http/specmaticTransport';

const baseResponse = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: { id: 'order-1' },
};

const validAdd = { source: 'overlay', op: 'add', path: '/status', value: 'active' };

function responseWithPatches(patches: unknown): unknown {
  return { ...baseResponse, _patches: patches };
}

describe('validateForwardedResponse journal validation', () => {
  it('preserves valid transport journal entries and their wire values', () => {
    const patches = [
      { source: 'overlay', op: 'add', path: '/added', value: null },
      { source: 'mask', op: 'remove', path: '/removed' },
      { source: 'reducer', op: 'replace', path: '/status', value: 'active' },
      { source: 'projection', op: 'move', path: '/new', from: '/old' },
      { source: 'seed', op: 'copy', path: '/copy', from: '/source' },
      { source: 'hateoas', op: 'append', path: '/items', value: { id: 1 } },
      { source: 'deprecation', op: 'prepend', path: '/items', value: true },
      { source: 'overlay', op: 'increment', path: '/count', by: 1.5 },
      { source: 'overlay', op: 'merge', path: '/metadata', value: { version: 2 } },
    ];

    expect(validateForwardedResponse(responseWithPatches(patches))).toEqual({
      ...baseResponse,
      _patches: patches,
    });
  });

  it.each([
    ['op', { ...validAdd, op: 'upsert' }],
    ['path', { ...validAdd, path: 'status' }],
    ['source', { ...validAdd, source: 'external' }],
    ['from', { ...validAdd, op: 'move', from: 'source' }],
    ['by', { ...validAdd, op: 'increment', by: Number.POSITIVE_INFINITY }],
    ['value', { ...validAdd, value: undefined }],
  ] as const)('filters entries with an invalid %s field', (_field, patch) => {
    expect(validateForwardedResponse(responseWithPatches([patch]))).toEqual({
      ...baseResponse,
      _patches: [],
    });
  });

  it('rejects a merge entry whose value is not a JSON object', () => {
    expect(
      validateForwardedResponse(
        responseWithPatches([{ source: 'overlay', op: 'merge', path: '/metadata', value: [] }]),
      ),
    ).toEqual({ ...baseResponse, _patches: [] });
  });

  it('retains only safe entries from a mixed array', () => {
    const validMove = { source: 'overlay', op: 'move', path: '/current', from: '/previous' };
    const invalidValue = { ...validAdd, path: '/valid', value: Number.NaN };

    expect(
      validateForwardedResponse(responseWithPatches([validAdd, invalidValue, validMove])),
    ).toEqual({
      ...baseResponse,
      _patches: [validAdd, validMove],
    });
  });

  it('omits patches when the field is absent', () => {
    expect(validateForwardedResponse(baseResponse)).toEqual(baseResponse);
  });

  it('retains the existing malformed non-array fallback', () => {
    expect(() => validateForwardedResponse(responseWithPatches('not-an-array'))).toThrow(
      '_patches must be an array when present',
    );
  });
});
