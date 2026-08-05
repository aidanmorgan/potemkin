import {
  boundary,
  boundaryName,
  componentName,
  contractPath,
  defineComponent,
  defineGlobal,
  event,
  eventType,
  field,
  fieldPath,
  faultName,
  behaviorName,
  guardName,
  linkRelation,
  operationId,
  pathSegment,
  reducerRule,
  type EventContext,
  type ComponentSource,
} from 'potemkin/sdk';

interface CreatedPayload {
  readonly id: string;
  readonly nested: { labels: string[] };
}

interface ResultState {
  readonly id: string;
  readonly nested: { readonly labels: readonly string[] };
}

export const created = event(eventType('ContractCreated'), {
  id: ({ command }: EventContext) => String(command.payload['id']),
  nested: ({ command }: EventContext) => ({
    labels: [String(command.payload['label'] ?? '')],
  }),
});

type CallbackResult<Value> = Value extends (...input: never[]) => infer Result ? Result : Value;
type Assert<T extends true> = T;
export type InferredPayload = {
  readonly [Key in keyof typeof created.payload]: CallbackResult<(typeof created.payload)[Key]>;
};
type PayloadShapeIsInferred = Assert<
  InferredPayload extends CreatedPayload
    ? CreatedPayload extends InferredPayload
      ? true
      : false
    : false
>;
const payloadShapeIsInferred: PayloadShapeIsInferred = true;

const reducer = reducerRule<CreatedPayload, ResultState>(eventType('ContractCreated'))
  .apply(({ state, event: emitted }) => {
    // @ts-expect-error Reducer state projections are deeply readonly.
    state.nested.labels.push('must-not-mutate');
    // @ts-expect-error Reducer event projections are deeply readonly.
    emitted.payload.nested.labels.push('must-not-mutate');
    return {
      ...state,
      id: emitted.payload.id,
      nested: { labels: [...state.nested.labels, ...emitted.payload.nested.labels] },
    };
  })
  .build();

// @ts-expect-error Built TypeScript reducers expose resultant-state transitions, not patch APIs.
void reducer.apply;

const contract = boundary(boundaryName('Contract'), contractPath(pathSegment('contracts')))
  .eventCatalog(created)
  .reducer(reducer)
  .behavior({
    name: behaviorName('create'),
    operationId: operationId('createContract'),
    condition: () => true,
    emit: eventType('ContractCreated'),
  });

const policies = defineGlobal({
  auth: { mode: 'jwt', jwt: { secret: 'compile-time-secret', algorithm: 'HS256' } },
  idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true },
  fallback: {
    rules: [
      {
        match: { method: 'POST', inContract: false },
        respond: { status: 404, body: { error: 'NOT_FOUND' } },
      },
    ],
  },
  lifecycle: { boot: async () => undefined },
  faults: [
    {
      name: faultName('payment-timeout'),
      matches: () => true,
      requires: [
        {
          name: guardName('can-simulate'),
          check: () => true,
          errorCode: 'SIMULATION_FORBIDDEN',
          errorMessage: 'The scenario cannot be simulated.',
        },
      ],
      selectors: { errorClass: 'timeout' },
      response: { status: 504, body: { error: 'TIMEOUT' } },
    },
  ],
});

// @ts-expect-error Global auth modes are a closed canonical union.
defineGlobal({ auth: { mode: 'oauth' } });

defineGlobal({
  faults: [
    {
      name: faultName('invalid'),
      matches: () => true,
      selectors: {
        // @ts-expect-error Fault error classes are a closed canonical union.
        errorClass: 'unknown',
      },
      response: { status: 500 },
    },
  ],
});

const componentSource: ComponentSource = {
  fallbackOverride: true,
  export: {
    states: [
      {
        name: 'created',
        steps: [{ operationId: operationId('createContract') }],
      },
    ],
  },
};
const component = defineComponent(componentName('ContractDefaults'), componentSource);

const typedPolicies = boundary(boundaryName('TypedPolicies'), contractPath(pathSegment('policies')))
  .identity({
    generate: ({ request }) => String(request?.headers['x-actor'] ?? 'anonymous'),
    key: { from: 'path', name: 'policyId' },
  })
  .response({
    mask: [fieldPath(field('secret'))],
    hateoas: [{ rel: linkRelation('self'), href: ({ command }) => command.path }],
    status: () => 201,
    headers: { 'x-potemkin': () => 'typed' },
  });

const invalidComponentSource: ComponentSource = {
  export: {
    states: [
      {
        name: 'created',
        steps: [
          {
            // @ts-expect-error Component export operation identifiers are canonical references.
            operationId: 'createContract',
          },
        ],
      },
    ],
  },
};

void contract;
void policies;
void component;
void typedPolicies;
void invalidComponentSource;
void payloadShapeIsInferred;
