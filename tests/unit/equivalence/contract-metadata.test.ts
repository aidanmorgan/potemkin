import { loadOpenApi } from '../../../src/contract/loader.js';
import { contractFieldPolicies } from '../../equivalence/contractMetadata.js';

describe('OpenAPI contract metadata for equivalence projections', () => {
  it('derives format families from the loaded response schema', async () => {
    const openapi = await loadOpenApi('examples/crm/openapi/nuisance-bureau.yaml');
    const fields = contractFieldPolicies(openapi, 'getLead');

    expect(fields['$.id']).toEqual({ format: 'uuid' });
    expect(fields['$.createdAt']).toEqual({ format: 'date-time' });
    expect(fields['$.notes.createdAt']).toEqual({ format: 'date-time' });
  });

  it('returns no policy for an unknown operation rather than inventing volatility', async () => {
    const openapi = await loadOpenApi('examples/crm/openapi/nuisance-bureau.yaml');
    expect(contractFieldPolicies(openapi, 'notAnOperation')).toEqual({});
  });
});
