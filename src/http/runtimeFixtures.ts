import type { JsonObject } from "../types.js";
import type { RuntimeSystem } from "../runtime/system.js";
import type { FixtureStub } from "./specmaticTransport.js";

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getByIdTemplate(system: RuntimeSystem, collectionPath: string): string | undefined {
  return Object.entries(system.openapi.paths)
    .filter(
      ([path, item]) =>
        path.startsWith(`${collectionPath}/`) &&
        /^\/\{[^/}]+\}$/.test(path.slice(collectionPath.length)) &&
        item.get !== undefined,
    )
    .map(([path]) => path)
    .sort()[0];
}

function getByIdParameter(pathTemplate: string): string {
  return /\/\{([^/}]+)\}$/.exec(pathTemplate)?.[1] ?? "id";
}

/**
 * Project deterministic runtime baselines into the Specmatic fixture shape.
 * The projection is transport-specific; the engine only exposes its events
 * and state through the RuntimeSystem contract.
 */
export function deriveRuntimeFixtures(system: RuntimeSystem): readonly FixtureStub[] {
  const baseline = system.engine
    .snapshot()
    .events.filter(
      (event) =>
        event.eventId.startsWith("baseline-") && system.program.byBoundaryName.has(event.boundary),
    );
  const fixtures: FixtureStub[] = [];
  for (const boundary of system.program.boundaries) {
    const pathTemplate = getByIdTemplate(system, boundary.contractPath);
    if (pathTemplate === undefined) continue;
    const parameter = getByIdParameter(pathTemplate);
    for (const event of baseline.filter((candidate) => candidate.boundary === boundary.boundary)) {
      if (!isJsonObject(event.payload)) continue;
      fixtures.push({
        httpRequest: {
          method: "GET",
          path: pathTemplate.replace(`{${parameter}}`, event.aggregateId),
        },
        httpResponse: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: event.payload,
        },
        source: {
          boundary: boundary.boundary,
          aggregateId: event.aggregateId,
          contractPath: pathTemplate,
        },
      });
    }
  }
  return fixtures.sort((left, right) =>
    left.httpRequest.path.localeCompare(right.httpRequest.path),
  );
}
