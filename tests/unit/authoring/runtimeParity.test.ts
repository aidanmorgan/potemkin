import {
  compareRuntimeDefinitions,
  type AuthoringParityRequest,
} from '../../equivalence/authoringParity.js';

const requests: readonly AuthoringParityRequest[] = [
  { method: 'POST', path: '/things', body: { name: 'Ada' } },
  { method: 'GET', path: '/things/one' },
];

describe('runtime authoring parity comparator', () => {
  it('compares the complete observable trace, not only responses', async () => {
    const runner = async () => ({
      responses: [{ status: 201, headers: { etag: 'fixed' }, body: { id: 'one' } }],
      events: [{ type: 'ThingCreated', payload: { id: 'one' } }],
      state: { one: { id: 'one' } },
      sideEffects: { webhooks: 1 },
    });
    const comparison = await compareRuntimeDefinitions(requests, runner, runner);
    expect(comparison).toMatchObject({ equal: true, differences: [] });
  });

  it('reports the first semantic state or response difference', async () => {
    const left = async () => ({
      responses: [{ status: 201, headers: {}, body: { id: 'one', status: 'NEW' } }],
      events: [],
      state: { one: { status: 'NEW' } },
    });
    const right = async () => ({
      responses: [{ status: 201, headers: {}, body: { id: 'one', status: 'DONE' } }],
      events: [],
      state: { one: { status: 'DONE' } },
    });
    const comparison = await compareRuntimeDefinitions(requests, left, right);
    expect(comparison.equal).toBe(false);
    expect(comparison.differences).toEqual(
      expect.arrayContaining(['$.responses[0].body.status', '$.state.one.status']),
    );
  });

  it('only ignores values explicitly removed by a normalizer', async () => {
    const left = async () => ({
      responses: [{ status: 201, headers: {}, body: { id: 'yaml-id' } }],
      events: [{ type: 'ThingCreated', id: 'yaml-event-id' }],
    });
    const right = async () => ({
      responses: [{ status: 201, headers: {}, body: { id: 'ts-id' } }],
      events: [{ type: 'ThingCreated', id: 'ts-event-id' }],
    });
    const comparison = await compareRuntimeDefinitions(requests, left, right, {
      normalizer: (value) =>
        JSON.parse(
          JSON.stringify(value)
            .replaceAll('yaml-id', 'symbolic-id')
            .replaceAll('ts-id', 'symbolic-id')
            .replaceAll('yaml-event-id', 'symbolic-event-id')
            .replaceAll('ts-event-id', 'symbolic-event-id'),
        ),
    });
    expect(comparison.equal).toBe(true);
  });
});
