import {
  PotemkinConfigure,
  boundary,
  boundaryName,
  contractPath,
  factoryName,
  field,
  linkRelation,
  pathParameter,
  pathSegment,
  queryPath,
  simulation,
} from 'potemkin/sdk';
import type { QueryContext } from 'potemkin/sdk';

const query = {
  fields: {
    threshold: ({ state, query }: Readonly<QueryContext>) =>
      Number(state['score']) >= Number(query['threshold']),
  },
  filter: ({ state }: { readonly state: Readonly<Record<string, unknown>> }) =>
    state['active'] === true,
  sort: (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>) =>
    Number(right['score']) - Number(left['score']),
  pageSize: () => 2,
  maxPageSize: 2,
  cursor: ({ query }: Readonly<QueryContext>) =>
    typeof query['cursor'] === 'string' ? query['cursor'] : undefined,
  expand: [queryPath(field('customerIds'))],
  pagination: 'envelope' as const,
  includeDeleted: true,
};

const order = boundary(boundaryName('Order'), contractPath(pathSegment('orders')))
  .fallbackOverride(true)
  .response({ hateoas: [{ rel: linkRelation('self'), href: '/orders' }] })
  .query(query)
  .initialization(
    { id: 'order-1', score: 1, active: true },
    { id: 'order-2', score: 3, active: true, customerIds: ['order-1'] },
    { id: 'order-3', score: 2, active: true },
    { id: 'order-4', score: 9, active: false },
    { id: 'order-deleted', score: 4, active: true, _deleted: true },
  );

const orderById = boundary(
  boundaryName('OrderById'),
  contractPath(pathSegment('orders'), pathParameter('id')),
)
  .fallbackOverride(true)
  .identity({ key: { from: 'path', name: 'id' } })
  .query({ fallback: () => ({ code: 'ORDER_NOT_FOUND' }) });

const probe = boundary(
  boundaryName('ProbeById'),
  contractPath(pathSegment('probes'), pathParameter('id')),
).identity({
  key: { from: 'path', name: 'id' },
});

export class QueryPolicyFactory {
  @PotemkinConfigure(factoryName('query-policy'))
  static create() {
    return simulation().boundary(order).boundary(orderById).boundary(probe).build();
  }
}
