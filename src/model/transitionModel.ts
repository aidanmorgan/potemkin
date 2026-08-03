/**
 * Versioned, source-independent static transition model.
 *
 * YAML and TypeScript are compiled before the runtime consumes this contract.
 * The HTTP endpoint exposes this value only as diagnostics; the execution
 * engine never branches on the model or on the source which produced it.
 */

import type { RuntimeModelCoverage } from "./runtime.js";

export interface TransitionWriteSet {
  readonly fields: readonly string[];
  readonly replaceState: boolean;
  readonly derivedClosure: readonly string[];
  readonly volatile: readonly string[];
}

export interface Transition {
  readonly from: string | "*";
  readonly to: string | "UNKNOWN";
  readonly op: string;
  readonly guardCel: string | null;
  readonly nextStateKnown: boolean;
}

export interface TransitionMachine {
  readonly aggregate: string;
  readonly controlField: string;
  readonly states: readonly string[];
  readonly transitions: readonly Transition[];
  readonly writeSets: Readonly<Record<string, TransitionWriteSet>>;
  /** Optional strict-analysis metadata supplied by the canonical policy. */
  readonly analysis?: RuntimeModelCoverage;
}

export interface TransitionModel {
  readonly schemaVersion: 1;
  readonly machines: readonly TransitionMachine[];
}

/** Merge source producers into the same versioned model without source tags. */
export function mergeTransitionModels(...models: readonly TransitionModel[]): TransitionModel {
  const machines = new Map<string, TransitionMachine>();
  for (const model of models) {
    for (const machine of model.machines) {
      const previous = machines.get(machine.aggregate);
      if (previous === undefined) {
        machines.set(machine.aggregate, machine);
        continue;
      }
      const writeSets = { ...previous.writeSets };
      for (const [operation, writeSet] of Object.entries(machine.writeSets)) {
        const current = writeSets[operation];
        writeSets[operation] =
          current === undefined
            ? writeSet
            : {
                fields: [...new Set([...current.fields, ...writeSet.fields])].sort(),
                replaceState: current.replaceState || writeSet.replaceState,
                derivedClosure: [
                  ...new Set([...current.derivedClosure, ...writeSet.derivedClosure]),
                ].sort(),
                volatile: [...new Set([...current.volatile, ...writeSet.volatile])].sort(),
              };
      }
      const transitionKeys = new Set(
        previous.transitions.map((transition) => JSON.stringify(transition)),
      );
      machines.set(machine.aggregate, {
        aggregate: previous.aggregate,
        controlField:
          previous.controlField === "state" ? machine.controlField : previous.controlField,
        states: [...new Set([...previous.states, ...machine.states])].sort(),
        transitions: [
          ...previous.transitions,
          ...machine.transitions.filter((transition) => {
            const key = JSON.stringify(transition);
            if (transitionKeys.has(key)) return false;
            transitionKeys.add(key);
            return true;
          }),
        ],
        writeSets,
        ...(previous.analysis === undefined && machine.analysis === undefined
          ? {}
          : { analysis: mergeAnalysis(previous.analysis, machine.analysis) }),
      });
    }
  }
  return {
    schemaVersion: 1,
    machines: [...machines.values()].sort((left, right) =>
      left.aggregate.localeCompare(right.aggregate),
    ),
  };
}

function mergeAnalysis(
  left: RuntimeModelCoverage | undefined,
  right: RuntimeModelCoverage | undefined,
): RuntimeModelCoverage {
  return {
    ...(left?.strict === true || right?.strict === true ? { strict: true } : {}),
    ...mergeList("initialStates", left?.initialStates, right?.initialStates),
    ...mergeList("terminalStates", left?.terminalStates, right?.terminalStates),
    ...mergeList("operations", left?.operations, right?.operations),
    ...mergeList("suppressStates", left?.suppressStates, right?.suppressStates),
  };
}

function mergeList(
  key: "initialStates" | "terminalStates" | "operations" | "suppressStates",
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): Partial<RuntimeModelCoverage> {
  const values = [...new Set([...(left ?? []), ...(right ?? [])])].sort();
  return values.length === 0 ? {} : { [key]: values };
}
