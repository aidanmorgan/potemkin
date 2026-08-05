import {
  behaviorName,
  boundaryName,
  componentName,
  contractPath,
  eventReference,
  eventType,
  faultName,
  guardName,
  field,
  fieldPath,
  queryPath,
  aggregateId,
  eventId,
  jsonPath,
  sequenceVersion,
  stateFieldName,
  factoryName,
  helperName,
  operationId,
  pathParameter,
  pathSegment,
  resourceName,
  sagaName,
  sagaStepName,
  webhookName,
  schemaReference,
  scopeName,
  linkRelation,
  ReferenceValidationError,
} from '../../../src/domain/references.js';
import { sdk } from '../../../src/sdk/index.js';

describe('TypeScript semantic references', () => {
  it('builds canonical identifiers and paths from typed constructors', () => {
    expect(boundaryName('Orders')).toBe('Orders');
    expect(behaviorName('create-order')).toBe('create-order');
    expect(componentName('OrderComponents')).toBe('OrderComponents');
    expect(helperName('formatOrder')).toBe('formatOrder');
    expect(factoryName('order-scenario')).toBe('order-scenario');
    expect(scopeName('orders:write')).toBe('orders:write');
    expect(linkRelation('self')).toBe('self');
    expect(resourceName('Order')).toBe('Order');
    expect(operationId('createOrder')).toBe('createOrder');
    expect(eventType('OrderCreated')).toBe('OrderCreated');
    expect(eventReference(boundaryName('Orders'), eventType('OrderCreated'))).toBe(
      'Orders:OrderCreated',
    );
    expect(faultName('unavailable')).toBe('unavailable');
    expect(guardName('allowed')).toBe('allowed');
    expect(sagaName('order-flow')).toBe('order-flow');
    expect(sagaStepName('reserve')).toBe('reserve');
    expect(webhookName('order-hook')).toBe('order-hook');
    expect(schemaReference('#/components/schemas/Order')).toBe('#/components/schemas/Order');
    expect(contractPath(pathSegment('orders'), pathParameter('id'))).toBe('/orders/{id}');
    expect(fieldPath(field('customer'), field('email'))).toBe('/customer/email');
    expect(queryPath(field('customer'), field('email'))).toBe('customer.email');
    expect(stateFieldName('version')).toBe('version');
    expect(aggregateId('order-1')).toBe('order-1');
    expect(eventId('event-1')).toBe('event-1');
    expect(jsonPath('/customer/email')).toBe('/customer/email');
    expect(sequenceVersion(3)).toBe(3);
  });

  it('rejects malformed semantic references before compilation', () => {
    expect(() => boundaryName(' ')).toThrow(
      expect.objectContaining({ code: 'DOMAIN_REFERENCE_INVALID' }),
    );
    expect(() => operationId(' ')).toThrow(ReferenceValidationError);
    expect(() => pathSegment('orders/items')).toThrow(ReferenceValidationError);
    expect(() => fieldPath()).toThrow(ReferenceValidationError);
    expect(() => queryPath()).toThrow(ReferenceValidationError);
    expect(() => stateFieldName(' ')).toThrow(ReferenceValidationError);
    expect(() => jsonPath('customer.email')).toThrow(ReferenceValidationError);
    expect(() => sequenceVersion(-1)).toThrow(ReferenceValidationError);
    expect(() => sequenceVersion(1.5)).toThrow(ReferenceValidationError);
  });

  it('publishes the constructors through the supported SDK object', () => {
    expect(sdk.boundaryName('Orders')).toBe('Orders');
    expect(sdk.behaviorName('create-order')).toBe('create-order');
    expect(sdk.componentName('OrderComponents')).toBe('OrderComponents');
    expect(sdk.helperName('formatOrder')).toBe('formatOrder');
    expect(sdk.factoryName('order-scenario')).toBe('order-scenario');
    expect(sdk.scopeName('orders:write')).toBe('orders:write');
    expect(sdk.linkRelation('self')).toBe('self');
    expect(sdk.resourceName('Order')).toBe('Order');
    expect(sdk.contractPath(sdk.pathSegment('orders'))).toBe('/orders');
    expect(sdk.queryPath(sdk.field('customer'), sdk.field('email'))).toBe('customer.email');
    expect(sdk.stateFieldName('version')).toBe('version');
    expect(sdk.eventType('OrderCreated')).toBe('OrderCreated');
    expect(sdk.eventReference(sdk.boundaryName('Orders'), sdk.eventType('OrderCreated'))).toBe(
      'Orders:OrderCreated',
    );
    expect(sdk.faultName('unavailable')).toBe('unavailable');
    expect(sdk.guardName('allowed')).toBe('allowed');
    expect(sdk.sagaName('order-flow')).toBe('order-flow');
    expect(sdk.sagaStepName('reserve')).toBe('reserve');
    expect(sdk.webhookName('order-hook')).toBe('order-hook');
    expect(sdk.expression('event', () => 'value')({})).toBe('value');
  });
});
