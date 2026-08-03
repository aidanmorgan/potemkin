import {
  boundary,
  boundaryName,
  contractPath,
  event,
  eventType,
  behaviorName,
  operationId,
  pathSegment,
  reducerRule,
  type EventContext,
} from "potemkin/sdk";

interface CreatedPayload {
  readonly id: string;
  readonly nested: { labels: string[] };
}

interface ResultState {
  readonly id: string;
  readonly nested: { readonly labels: readonly string[] };
}

export const created = event(eventType("ContractCreated"), {
  id: ({ command }: EventContext) => String(command.payload["id"]),
  nested: ({ command }: EventContext) => ({
    labels: [String(command.payload["label"] ?? "")],
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

const reducer = reducerRule<CreatedPayload, ResultState>(eventType("ContractCreated"))
  .apply(({ state, event: emitted }) => {
    // @ts-expect-error Reducer state projections are deeply readonly.
    state.nested.labels.push("must-not-mutate");
    // @ts-expect-error Reducer event projections are deeply readonly.
    emitted.payload.nested.labels.push("must-not-mutate");
    return {
      ...state,
      id: emitted.payload.id,
      nested: { labels: [...state.nested.labels, ...emitted.payload.nested.labels] },
    };
  })
  .build();

const contract = boundary(boundaryName("Contract"), contractPath(pathSegment("contracts")))
  .event(created)
  .reducer(reducer)
  .behavior({
    name: behaviorName("create"),
    operationId: operationId("createContract"),
    condition: () => true,
    emit: eventType("ContractCreated"),
  });

void contract;
void payloadShapeIsInferred;
