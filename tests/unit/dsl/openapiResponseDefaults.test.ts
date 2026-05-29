import {
  extractDefaultHateoas,
  extractDefaultDeprecation,
  type OpenApiOperation,
  type OperationLookup,
} from '../../../src/dsl/openapiResponseDefaults.js';

const lookup: OperationLookup = {
  resolveOperationPath: (id) =>
    ({
      getLead: '/leads/{leadId}',
      listLeads: '/leads',
    })[id],
};

describe('extractDefaultHateoas', () => {
  it('emits entries for every link block on the matched response code', () => {
    const op: OpenApiOperation = {
      responses: {
        '201': {
          links: {
            self: { operationId: 'getLead', parameters: { leadId: '$response.body#/id' } },
            collection: { operationId: 'listLeads' },
          },
        },
      },
    };
    const entries = extractDefaultHateoas(op, 201, lookup);
    expect(entries).toEqual([
      { rel: 'self', href: '/leads/$response.body#/id' },
      { rel: 'collection', href: '/leads' },
    ]);
  });

  it('falls back to default response when status code does not match', () => {
    const op: OpenApiOperation = {
      responses: {
        default: { links: { self: { operationId: 'listLeads' } } },
      },
    };
    expect(extractDefaultHateoas(op, 500, lookup)).toEqual([
      { rel: 'self', href: '/leads' },
    ]);
  });

  it('returns [] when no responses block or no links', () => {
    expect(extractDefaultHateoas(undefined, 200, lookup)).toEqual([]);
    expect(extractDefaultHateoas({ responses: {} }, 200, lookup)).toEqual([]);
  });
});

describe('extractDefaultDeprecation', () => {
  it('returns {} (Deprecation: true header) when operation.deprecated === true', () => {
    expect(extractDefaultDeprecation({ deprecated: true })).toEqual({});
  });

  it('returns undefined when deprecated is false or absent', () => {
    expect(extractDefaultDeprecation({ deprecated: false })).toBeUndefined();
    expect(extractDefaultDeprecation({})).toBeUndefined();
    expect(extractDefaultDeprecation(undefined)).toBeUndefined();
  });
});
