import type { PotemkinConfiguration } from '../contracts/config.js';
import type { OpenApiDocumentDescriptor } from '../contracts/openapi.js';
import type { SimulationBuilder, SimulationDefinition } from './types.js';
import { TypeScriptAuthoringError } from './errors.js';
import { factoryName, type FactoryName } from '../domain/references.js';

/** Context supplied to a discovered TypeScript engine factory. */
export interface FactoryContext {
  readonly openapi: OpenApiDocumentDescriptor;
  readonly configuration: PotemkinConfiguration;
  /** Every TypeScript file selected by the active scan globs. */
  readonly sourceFiles: readonly string[];
}

export type FactoryOutput = SimulationDefinition | SimulationBuilder;

export type TypeScriptFactory = (context: FactoryContext) => FactoryOutput | Promise<FactoryOutput>;

export interface RegisteredFactory {
  readonly name: FactoryName;
  readonly factory: TypeScriptFactory;
  readonly source: string;
}

export interface FactoryRegistrar {
  register(entry: RegisteredFactory): void;
  snapshot(): readonly RegisteredFactory[];
}

/** Per-load factory collection; it deliberately has no process-global state. */
export class FactoryCollector implements FactoryRegistrar {
  private readonly entries = new Map<FactoryName, RegisteredFactory>();

  snapshot(): readonly RegisteredFactory[] {
    return [...this.entries.values()];
  }

  register(entry: RegisteredFactory): void {
    const existing = this.entries.get(entry.name);
    if (existing !== undefined) {
      throw new TypeScriptAuthoringError(
        'TS_FACTORY_CONFLICT',
        `Factory "${entry.name}" is already registered from ${existing.source}`,
        {
          details: { name: entry.name, existingSource: existing.source, source: entry.source },
          source: entry.source,
        },
      );
    }
    this.entries.set(entry.name, entry);
  }
}

function registerFactory(
  name: FactoryName,
  implementation: TypeScriptFactory,
  source: string,
  registrar: FactoryRegistrar | undefined,
): TypeScriptFactory {
  validateFactoryName(name);
  if (typeof implementation !== 'function') {
    throw new TypeScriptAuthoringError(
      'TS_FACTORY_INVALID',
      `TypeScript factory "${name}" must be a function`,
      { details: { name }, source },
    );
  }
  registrar?.register({ name, factory: implementation, source });
  return implementation;
}

/**
 * `MethodDecorator` exposes descriptor values as `any` because it is a
 * reflection API. Keep that untyped boundary in one runtime guard instead of
 * asserting a type at each use site.
 */
function isTypeScriptFactory(value: unknown): value is TypeScriptFactory {
  return typeof value === 'function';
}

function configure(
  name: FactoryName | undefined,
  registrar: FactoryRegistrar | undefined,
): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    if (typeof target !== 'function') {
      throw new TypeScriptAuthoringError(
        'TS_DECORATOR_INVALID',
        `@PotemkinConfigure must decorate a static method; "${String(propertyKey)}" is an instance method`,
        { details: { property: String(propertyKey) } },
      );
    }
    const implementation = descriptor?.value;
    if (!isTypeScriptFactory(implementation)) {
      throw new TypeScriptAuthoringError(
        'TS_DECORATOR_INVALID',
        `@PotemkinConfigure must decorate a callable method: "${String(propertyKey)}"`,
        { details: { property: String(propertyKey) } },
      );
    }
    const className = target.name || 'AnonymousFactory';
    const nameValue = name ?? factoryName(`${className}.${String(propertyKey)}`);
    const boundImplementation: TypeScriptFactory = (context) =>
      implementation.call(target, context);
    registerFactory(
      nameValue,
      boundImplementation,
      `class:${className}.${String(propertyKey)}`,
      registrar,
    );
  };
}

/**
 * Marks a static class method as a Potemkin engine configuration factory.
 *
 * ```ts
 * class Scenario {
 *   @PotemkinConfigure(factoryName("crm"))
 *   static create(context: FactoryContext) {
 *     return simulation().boundary(...).build();
 *   }
 * }
 * ```
 *
 * The method is invoked only after all selected modules and relative
 * TypeScript dependencies have been loaded. It is never invoked as a class
 * constructor, so factory classes remain side-effect free at discovery time.
 */
export function PotemkinConfigure(name?: FactoryName): MethodDecorator {
  return configure(name, undefined);
}

function validateFactoryName(name: string): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeScriptAuthoringError(
      'TS_FACTORY_INVALID',
      'A TypeScript factory requires a non-empty name',
    );
  }
}

export function createPotemkinConfigure(
  registrar: FactoryRegistrar,
): (name?: FactoryName) => MethodDecorator {
  return (name) => configure(name, registrar);
}
