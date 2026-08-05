import type { OpenApiDoc } from '../../contract/loader.js';
import type { Transition, TransitionMachine } from '../../model/transitionModel.js';
import type { LintCheck, LintFinding } from '../types.js';

/**
 * Check the aggregated, source-independent transition model.
 *
 * The checker deliberately consumes the model supplied by the boot boundary;
 * it never reaches through HTTP and never parses YAML or TypeScript. That
 * keeps structural diagnostics identical for both authoring surfaces.
 */
export const transitionModelCheck: LintCheck = (context) => {
  const model = context.transitionModel;
  if (model === undefined) return [];

  return model.machines.flatMap((machine) => checkMachine(machine, context.openapi));
};

function checkMachine(machine: TransitionMachine, openapi: OpenApiDoc): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  const knownStates = new Set(machine.states);
  const knownTargets = new Set(
    machine.transitions
      .filter((transition) => transition.nextStateKnown && transition.to !== 'UNKNOWN')
      .map((transition) => transition.to),
  );
  const analysis = machine.analysis;

  if (analysis?.strict === true) {
    findings.push(...strictGraphFindings(machine, knownStates));
  }

  const contractStates = contractEnumStates(machine, openapi);
  if (contractStates.length > 0) {
    findings.push(...coverageFindings(machine, contractStates, knownTargets));
  }
  findings.push(...guardFindings(machine, knownTargets));
  return findings;
}

function strictGraphFindings(
  machine: TransitionMachine,
  states: ReadonlySet<string>,
): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  const initialStates = initialStatesFor(machine, states);
  const reachable = reachableStates(machine.transitions, initialStates);

  if (initialStates.length > 0) {
    for (const state of states) {
      if (!reachable.has(state)) {
        findings.push(
          finding('MODEL_UNREACHABLE_STATE', `State "${state}" is unreachable`, machine),
        );
      }
    }
  }

  const terminalStates = new Set(machine.analysis?.terminalStates ?? []);
  const analysisStates = initialStates.length > 0 ? [...reachable] : [...states];
  for (const state of analysisStates) {
    if (terminalStates.has(state)) continue;
    if (outgoing(machine.transitions, state).length === 0) {
      findings.push(
        finding(
          'MODEL_DEAD_STATE',
          `State "${state}" has no legal outgoing transition and is not terminal`,
          machine,
        ),
      );
    }
  }

  const operations = new Set([
    ...(machine.analysis?.operations ?? []),
    ...Object.keys(machine.writeSets),
    ...machine.transitions.map((transition) => transition.op),
  ]);
  for (const state of analysisStates) {
    if (terminalStates.has(state)) continue;
    for (const operation of operations) {
      if (!hasTransition(machine.transitions, state, operation)) {
        findings.push(
          finding(
            'MODEL_TOTALITY_GAP',
            `No transition is defined for state "${state}" and operation "${operation}"`,
            machine,
          ),
        );
      }
    }
  }
  return findings;
}

function initialStatesFor(
  machine: TransitionMachine,
  states: ReadonlySet<string>,
): readonly string[] {
  const configured = machine.analysis?.initialStates?.filter((state) => states.has(state)) ?? [];
  if (configured.length > 0) return configured;
  const incoming = new Set(
    machine.transitions
      .filter((transition) => transition.to !== 'UNKNOWN')
      .map((transition) => transition.to),
  );
  return [...states].filter((state) => !incoming.has(state));
}

function reachableStates(
  transitions: readonly Transition[],
  initialStates: readonly string[],
): ReadonlySet<string> {
  const reachable = new Set(initialStates);
  const pending = [...initialStates];
  while (pending.length > 0) {
    const state = pending.shift()!;
    for (const transition of outgoing(transitions, state)) {
      if (transition.to === 'UNKNOWN' || reachable.has(transition.to)) continue;
      reachable.add(transition.to);
      pending.push(transition.to);
    }
  }
  return reachable;
}

function outgoing(transitions: readonly Transition[], state: string): readonly Transition[] {
  return transitions.filter((transition) => transition.from === '*' || transition.from === state);
}

function hasTransition(
  transitions: readonly Transition[],
  state: string,
  operation: string,
): boolean {
  return transitions.some(
    (transition) =>
      transition.op === operation && (transition.from === '*' || transition.from === state),
  );
}

function coverageFindings(
  machine: TransitionMachine,
  contractStates: readonly string[],
  knownTargets: ReadonlySet<string>,
): readonly LintFinding[] {
  const suppressed = new Set(machine.analysis?.suppressStates ?? []);
  const findings: LintFinding[] = [];
  for (const state of suppressed) {
    if (!contractStates.includes(state)) {
      findings.push(
        finding(
          'MODEL_UNKNOWN_STATE_SUPPRESSION',
          `Suppressed state "${state}" is not present in the OpenAPI enum for ${machine.aggregate}.${machine.controlField}`,
          machine,
        ),
      );
    }
  }
  for (const state of contractStates) {
    if (knownTargets.has(state) || suppressed.has(state)) continue;
    findings.push(
      finding(
        'MODEL_CONTRACT_STATE_UNCOVERED',
        `OpenAPI enum state "${state}" has no realizing transition`,
        machine,
        'warning',
      ),
    );
  }
  return findings;
}

function guardFindings(
  machine: TransitionMachine,
  knownTargets: ReadonlySet<string>,
): readonly LintFinding[] {
  const produced = new Set(knownTargets);
  const values = new Set<string>();
  const pattern = new RegExp(
    `state\\.${escapeRegExp(machine.controlField)}\\s*(?:==|!=)\\s*(['"])([^'"]+)\\1`,
    'g',
  );
  for (const transition of machine.transitions) {
    if (transition.guardCel === null) continue;
    for (const match of transition.guardCel.matchAll(pattern)) values.add(match[2]!);
  }
  return [...values]
    .filter((state) => !produced.has(state))
    .map((state) =>
      finding(
        'MODEL_GUARD_STATE_UNPRODUCED',
        `Guard references state "${state}", but no transition produces it`,
        machine,
        'warning',
      ),
    );
}

function contractEnumStates(machine: TransitionMachine, openapi: OpenApiDoc): readonly string[] {
  const schemas = record(record(record(openapi.raw)?.components)?.schemas);
  if (schemas === undefined) return [];
  const names = [machine.aggregate, machine.aggregate.toLowerCase()];
  const schemaName = names.find((name) => schemas[name] !== undefined);
  if (schemaName === undefined) return [];
  const schema = resolveSchema(schemas[schemaName], schemas);
  const field = record(schema?.properties)?.[machine.controlField];
  const values = record(field)?.enum;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string')
    : [];
}

function resolveSchema(
  value: unknown,
  schemas: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const schema = record(value);
  if (schema === undefined) return undefined;
  const ref = schema['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
    return resolveSchema(schemas[ref.slice('#/components/schemas/'.length)], schemas);
  }
  if (!Array.isArray(schema['allOf'])) return schema;
  return schema['allOf'].reduce<Record<string, unknown>>(
    (merged, part) => ({ ...merged, ...resolveSchema(part, schemas) }),
    { ...schema },
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finding(
  code: string,
  message: string,
  machine: TransitionMachine,
  severity: 'error' | 'warning' = 'error',
): LintFinding {
  return {
    severity,
    code,
    message,
    location: { boundary: machine.aggregate, pointer: machine.controlField },
    details: {
      aggregate: machine.aggregate,
      controlField: machine.controlField,
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
