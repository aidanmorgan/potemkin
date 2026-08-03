import {
  PotemkinConfigure,
  boundary,
  defineFault,
  event,
  factoryName,
  reducerRule,
  simulation,
  type FactoryContext,
} from "potemkin/sdk";

function jobBoundary(
  name: string,
  contractPath: string,
  operationId: string,
  eventType: string,
  latency: { fixedMs?: number; minMs?: number; maxMs?: number },
) {
  return boundary(name, contractPath)
    .fallbackOverride(false)
    .latency(latency)
    .identity({ generate: ({ helpers }) => helpers.uuid() })
    .eventCatalog(
      event(eventType, {
        id: ({ command }) => String(command.targetId ?? ""),
        name: ({ command }) => String(command.payload.name ?? ""),
      }),
    )
    .behavior({
      name: operationId,
      operationId,
      condition: () => true,
      emit: eventType,
    })
    .faults(
      defineFault({
        name: "delayed-job-fault",
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
      reducerRule(eventType)
        .apply(({ state, event: emitted }) => ({
          ...state,
          id: String(emitted.payload.id),
          name: String(emitted.payload.name),
        }))
        .build(),
    )
    .build();
}

export class LatencyFactory {
  @PotemkinConfigure(factoryName("latency-typescript"))
  static create(_context: FactoryContext) {
    return simulation()
      .boundary(jobBoundary("Job", "/jobs", "submitJob", "JobSubmitted", { fixedMs: 60 }))
      .boundary(boundary("JobById", "/jobs/{id}").fallbackOverride(true).build())
      .boundary(
        jobBoundary("JobRanged", "/jobs/ranged", "submitRangedJob", "RangedJobSubmitted", {
          minMs: 40,
          maxMs: 80,
        }),
      )
      .boundary(
        jobBoundary("JobStacked", "/jobs/stacked", "submitStackedJob", "StackedJobSubmitted", {
          fixedMs: 20,
          minMs: 30,
          maxMs: 60,
        }),
      )
      .build();
  }
}
