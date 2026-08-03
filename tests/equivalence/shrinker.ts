import type { EquivalenceRequest } from "./types.js";

export interface DependentRequest extends EquivalenceRequest {
  readonly dependsOn?: readonly number[];
}

export interface ShrinkOptions {
  /** Keep the dependency closure instead of allowing symbolic references to be dropped. */
  readonly preserveDependencies?: boolean;
}

/** Remove chunks while retaining the symbolic dependencies of later requests. */
export async function shrinkDivergingSequence(
  sequence: readonly DependentRequest[],
  diverges: (candidate: readonly DependentRequest[]) => boolean | Promise<boolean>,
  options: ShrinkOptions = {},
): Promise<readonly DependentRequest[]> {
  const original = [...sequence];
  let retained = original.map((_, index) => index);
  let changed = true;
  while (changed) {
    changed = false;
    for (let position = 0; position < retained.length; position++) {
      const candidateIndices = retained.filter(
        (_, candidatePosition) => candidatePosition !== position,
      );
      if (options.preserveDependencies && !dependenciesValid(original, candidateIndices)) continue;
      const retainedSet = new Set(candidateIndices);
      const candidate = candidateIndices.map((index) => {
        const request = original[index];
        const dependencies = (request.dependsOn ?? [])
          .filter((dependency) => !options.preserveDependencies || retainedSet.has(dependency))
          .map((dependency) => candidateIndices.indexOf(dependency))
          .filter((dependency) => dependency >= 0);
        return dependencies.length > 0
          ? { ...request, dependsOn: dependencies }
          : (() => {
              const { dependsOn: _dependsOn, ...withoutDependencies } = request;
              return withoutDependencies;
            })();
      });
      if (await diverges(candidate)) {
        retained = candidateIndices;
        changed = true;
        break;
      }
    }
  }
  return Object.freeze(
    retained.map((index) => {
      const request = original[index]!;
      const retainedSet = new Set(retained);
      const dependencies = (request.dependsOn ?? [])
        .filter((dependency) => !options.preserveDependencies || retainedSet.has(dependency))
        .map((dependency) => retained.indexOf(dependency))
        .filter((dependency) => dependency >= 0);
      return dependencies.length > 0
        ? { ...request, dependsOn: dependencies }
        : (() => {
            const { dependsOn: _dependsOn, ...withoutDependencies } = request;
            return withoutDependencies;
          })();
    }),
  );
}

function dependenciesValid(
  original: readonly DependentRequest[],
  retained: readonly number[],
): boolean {
  const retainedSet = new Set(retained);
  return retained.every((index) =>
    (original[index].dependsOn ?? []).every((dependency) => retainedSet.has(dependency)),
  );
}
