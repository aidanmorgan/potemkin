import {
  AggregateId,
  behaviorName,
  BoundaryName,
  boundaryName,
  CommandId,
  componentName,
  contractPath,
  EventId,
  EventType,
  eventReference,
  eventType,
  FaultId,
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
  OperationId,
  HttpMethod,
  httpMethods,
  httpMethod,
  pathParameter,
  pathSegment,
  resourceName,
  sagaName,
  sagaStepName,
  webhookName,
  schemaReference,
  SchemaReference,
  scopeName,
  SequenceVersion,
  linkRelation,
  ReferenceValidationError,
} from '../../../src/domain/references.js';
import * as sdkModule from '../../../src/sdk/index.js';
import { sdk } from '../../../src/sdk/index.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;

const sdkOperationId = sdk.operationId('createOrder');
const sdkSchemaReference = sdk.schemaReference('Order');
type SdkOperationIdPreservesLiteral = Assert<
  Equal<typeof sdkOperationId, OperationId<'createOrder'>>
>;
type SdkSchemaReferencePreservesLiteral = Assert<
  Equal<typeof sdkSchemaReference, SchemaReference<'Order'>>
>;
const sdkOperationIdTypeCheck: SdkOperationIdPreservesLiteral = true;
const sdkSchemaReferenceTypeCheck: SdkSchemaReferencePreservesLiteral = true;

// @ts-expect-error Raw strings cannot cross branded reference boundaries.
const rawOperationId: OperationId = 'createOrder';
// @ts-expect-error Raw strings cannot cross branded reference boundaries.
const rawSchemaReference: SchemaReference = 'Order';

void sdkOperationIdTypeCheck;
void sdkSchemaReferenceTypeCheck;
void sdkOperationId;
void sdkSchemaReference;
void rawOperationId;
void rawSchemaReference;

const parsedOperationId = OperationId.parse(' createOrder ');
const literalOperationId = OperationId.literal('createOrder');
type ParsedOperationIdIsBroad = Assert<Equal<typeof parsedOperationId, OperationId>>;
type LiteralOperationIdPreservesLiteral = Assert<
  Equal<typeof literalOperationId, OperationId<'createOrder'>>
>;
const parsedOperationIdTypeCheck: ParsedOperationIdIsBroad = true;
const literalOperationIdTypeCheck: LiteralOperationIdPreservesLiteral = true;

void parsedOperationIdTypeCheck;
void literalOperationIdTypeCheck;
void parsedOperationId;
void literalOperationId;

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
    expect(httpMethod('post')).toBe('POST');
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
    expect(jsonPath('')).toBe('');
    expect(sequenceVersion(3)).toBe(3);
  });

  it('rejects malformed semantic references before compilation', () => {
    expect(() => boundaryName(' ')).toThrow(
      expect.objectContaining({ code: 'DOMAIN_REFERENCE_INVALID' }),
    );
    expect(() => operationId(' ')).toThrow(ReferenceValidationError);
    expect(() => httpMethod('CONNECT')).toThrow(ReferenceValidationError);
    expect(() => pathSegment('orders/items')).toThrow(ReferenceValidationError);
    expect(() => fieldPath()).toThrow(ReferenceValidationError);
    expect(() => queryPath()).toThrow(ReferenceValidationError);
    expect(() => stateFieldName(' ')).toThrow(ReferenceValidationError);
    expect(() => jsonPath('customer.email')).toThrow(ReferenceValidationError);
    expect(() => sequenceVersion(-1)).toThrow(ReferenceValidationError);
    expect(() => sequenceVersion(1.5)).toThrow(ReferenceValidationError);
  });

  it('separates normalizing parsers from literal-preserving constructors', () => {
    expect(OperationId.parse(' createOrder ')).toBe('createOrder');
    expect(OperationId.literal('createOrder')).toBe('createOrder');
    expect(operationId('createOrder')).toBe('createOrder');
    expect(() => OperationId.literal(' createOrder ')).toThrow(ReferenceValidationError);
    expect(() => operationId(' createOrder ')).toThrow(ReferenceValidationError);

    expect(EventType.parse(' OrderCreated ')).toBe('OrderCreated');
    expect(EventType.literal('OrderCreated')).toBe('OrderCreated');
    expect(() => EventType.literal(' OrderCreated ')).toThrow(ReferenceValidationError);

    expect(SchemaReference.parse(' Order ')).toBe('Order');
    expect(SchemaReference.literal('Order')).toBe('Order');
    expect(() => SchemaReference.literal(' Order ')).toThrow(ReferenceValidationError);
  });

  it('provides type companions without changing primitive runtime values', () => {
    expect(BoundaryName.parse(' Orders ')).toBe('Orders');
    expect(AggregateId.parse(' order-1 ')).toBe('order-1');
    expect(EventId.parse(' event-1 ')).toBe('event-1');
    expect(CommandId.parse(' command-1 ')).toBe('command-1');
    expect(FaultId.parse(' fault-1 ')).toBe('fault-1');
    expect(SequenceVersion.parse(3)).toBe(3);
    expect(HttpMethod.parse(' post ')).toBe(HttpMethod.Post);

    expect(Object.isFrozen(BoundaryName)).toBe(true);
    expect(Object.isFrozen(HttpMethod)).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(HttpMethod, 'parse')).toBe(false);
    expect(Object.values(HttpMethod)).toEqual(httpMethods);
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
    expect(sdk.operationId('createOrder')).toBe('createOrder');
    expect(sdk.schemaReference('Order')).toBe('Order');
    expect(sdk.BoundaryName.parse(' Orders ')).toBe('Orders');
    expect(sdk.EventType.parse(' OrderCreated ')).toBe('OrderCreated');
    expect(sdk.OperationId.parse(' createOrder ')).toBe('createOrder');
    expect(sdk.SchemaReference.parse(' Order ')).toBe('Order');
    expect(sdk.HttpMethod.parse(' post ')).toBe('POST');
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

  it('publishes every authoring definition helper through the injected SDK object', () => {
    expect(sdk.defineResponse({})).toEqual({});
    expect(sdk.defineQuery({})).toEqual({});
  });

  it('keeps the injected SDK facade aligned with the public authoring exports', () => {
    const sharedExports = [
      'all',
      'any',
      'not',
      'pipe',
      'compose',
      'mapReadonly',
      'concatReadonly',
      'query',
      'expression',
      'event',
      'behavior',
      'reducerRule',
      'defineSimulation',
      'defineEvent',
      'defineBehavior',
      'defineFault',
      'defineReaction',
      'defineWebhook',
      'defineSaga',
      'defineProjection',
      'defineGlobal',
      'defineResponse',
      'defineQuery',
      'boundary',
      'simulation',
      'defineHelper',
      'yamlComponent',
      'BoundaryName',
      'boundaryName',
      'behaviorName',
      'contractPath',
      'eventReference',
      'EventType',
      'faultName',
      'guardName',
      'sagaName',
      'sagaStepName',
      'webhookName',
      'field',
      'fieldPath',
      'queryPath',
      'stateFieldName',
      'helperName',
      'linkRelation',
      'OperationId',
      'SchemaReference',
      'HttpMethod',
      'projectionName',
      'reactionName',
      'pathParameter',
      'pathSegment',
      'resourceName',
      'scopeName',
      'ReferenceValidationError',
    ] as const;

    for (const name of sharedExports) expect(sdkModule[name]).toBe(sdk[name]);
  });
});
