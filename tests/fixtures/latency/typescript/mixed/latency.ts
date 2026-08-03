import {
  PotemkinConfigure,
  boundary,
  boundaryName,
  contractPath,
  behaviorName,
  defineBehavior,
  defineFault,
  event,
  faultName,
  factoryName,
  eventType,
  operationId,
  pathSegment,
  reducerRule,
  simulation,
  type EventContext,
  type FactoryContext,
  type LatencyDefinition,
  type BoundaryName,
  type ContractPath,
  type EventType,
  type OperationId,
} from "potemkin/sdk";

function jobBoundary(
  name: BoundaryName,
  path: ContractPath,
  operation: OperationId,
  emittedEvent: EventType,
  latency: LatencyDefinition,
) {
  return boundary(name, path)
    .fallbackOverride(false)
    .latency(latency)
    .identity({ generate: ({ helpers }) => helpers.uuid() })
    .eventCatalog(
      event(emittedEvent, {
        id: ({ command }: EventContext) => String(command.targetId ?? ""),
        name: ({ command }: EventContext) => String(command.payload.name ?? ""),
      }),
    )
    .behavior(
      defineBehavior({
        name: behaviorName(operation),
        operationId: operation,
        condition: () => true,
        emit: emittedEvent,
      }),
    )
    .faults(
      defineFault({
        name: faultName("delayed-job-fault"),
        headers: { "x-latency-fault": "on" },
        matches: ({ headers }) => headers["x-latency-fault"] === "on",
        response: {
          status: 503,
          body: { error: "DELAYED_JOB_FAULT", message: "simulated delayed job failure" },
        },
        delayMs: 25,
      }),
    )
    .reducer(
      reducerRule(emittedEvent)
        .apply(({ state, event: emitted }) => ({
          ...state,
          id: String(emitted.payload.id),
          name: String(emitted.payload.name),
        }))
        .build(),
    )
    .build();
}

export class MixedLatencyFactory {
  @PotemkinConfigure(factoryName("latency-mixed-typescript"))
  static create(_context: FactoryContext) {
    return simulation()
      .boundary(
        jobBoundary(
          boundaryName("Job"),
          contractPath(pathSegment("jobs")),
          operationId("submitJob"),
          eventType("JobSubmitted"),
          { fixedMs: 60 },
        ),
      )
      .boundary(
        jobBoundary(
          boundaryName("JobRanged"),
          contractPath(pathSegment("jobs"), pathSegment("ranged")),
          operationId("submitRangedJob"),
          eventType("RangedJobSubmitted"),
          { minMs: 40, maxMs: 80 },
        ),
      )
      .boundary(
        jobBoundary(
          boundaryName("JobStacked"),
          contractPath(pathSegment("jobs"), pathSegment("stacked")),
          operationId("submitStackedJob"),
          eventType("StackedJobSubmitted"),
          { fixedMs: 20, minMs: 30, maxMs: 60 },
        ),
      )
      .build();
  }
}
