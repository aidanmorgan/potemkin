import path from 'node:path';

export type TestValueRole =
  | 'canonical unit contract'
  | 'source parity'
  | 'real Specmatic contract'
  | 'integration boundary'
  | 'consumer example contract'
  | 'property invariant'
  | 'adversarial regression'
  | 'requirement traceability';

export interface TestValuePolicy {
  readonly id: string;
  readonly pathPrefix: string;
  readonly role: TestValueRole;
  readonly purpose: string;
  readonly canonicalBoundary: string;
  readonly canonicalTests: readonly string[];
}

const UNIT_POLICIES: Readonly<Record<string, TestValuePolicy>> = {
  __root__: {
    id: 'unit-cross-cutting',
    pathPrefix: 'tests/unit',
    role: 'canonical unit contract',
    purpose: 'Cross-cutting public errors, configuration, or fixture behavior.',
    canonicalBoundary: 'src/index.ts, src/config.ts, and public error contracts',
    canonicalTests: ['tests/unit/errors.test.ts', 'tests/unit/config.test.ts'],
  },
  audit: {
    id: 'unit-audit',
    pathPrefix: 'tests/unit/audit',
    role: 'requirement traceability',
    purpose: 'Architecture, source-tree, feature-completeness, and no-legacy invariants.',
    canonicalBoundary: 'package boundaries and documented requirements',
    canonicalTests: ['tests/unit/audit/sourceTree.test.ts'],
  },
  authoring: {
    id: 'unit-authoring',
    pathPrefix: 'tests/unit/authoring',
    role: 'canonical unit contract',
    purpose: 'Typed TypeScript SDK construction and lowering into the source-neutral model.',
    canonicalBoundary: 'src/authoring and src/sdk',
    canonicalTests: ['tests/unit/authoring/runtimeParity.test.ts'],
  },
  cel: {
    id: 'unit-cel',
    pathPrefix: 'tests/unit/cel',
    role: 'canonical unit contract',
    purpose: 'CEL parsing, evaluation, built-ins, and evaluator safety.',
    canonicalBoundary: 'src/cel',
    canonicalTests: ['tests/unit/cel/evaluator.test.ts'],
  },
  cli: {
    id: 'unit-cli',
    pathPrefix: 'tests/unit/cli',
    role: 'canonical unit contract',
    purpose: 'CLI export and tooling behavior at the command boundary.',
    canonicalBoundary: 'src/cli',
    canonicalTests: ['tests/unit/cli/exportExamples.test.ts'],
  },
  config: {
    id: 'unit-config',
    pathPrefix: 'tests/unit/config.test.ts',
    role: 'canonical unit contract',
    purpose: 'The single potemkin.yml configuration contract and validation.',
    canonicalBoundary: 'src/config.ts',
    canonicalTests: ['tests/unit/config.test.ts'],
  },
  conformance: {
    id: 'unit-conformance',
    pathPrefix: 'tests/unit/conformance',
    role: 'canonical unit contract',
    purpose: 'Specmatic process, gate, corpus, allowlist, and JUnit integration contracts.',
    canonicalBoundary: 'src/conformance',
    canonicalTests: ['tests/unit/conformance/gate.test.ts'],
  },
  contract: {
    id: 'unit-contract',
    pathPrefix: 'tests/unit/contract',
    role: 'canonical unit contract',
    purpose: 'OpenAPI loading, routing, form fields, validation, and error bodies.',
    canonicalBoundary: 'src/contract',
    canonicalTests: ['tests/unit/contract/loader.test.ts'],
  },
  core: {
    id: 'unit-core',
    pathPrefix: 'tests/unit/core',
    role: 'canonical unit contract',
    purpose: 'Source-neutral engine execution, storage, policies, and import boundaries.',
    canonicalBoundary: 'src/core',
    canonicalTests: ['tests/unit/core/runtimeEngine.test.ts'],
  },
  dsl: {
    id: 'unit-dsl',
    pathPrefix: 'tests/unit/dsl',
    role: 'canonical unit contract',
    purpose: 'YAML definition, CEL/DSL parsing, compilation, composition, and expansion.',
    canonicalBoundary: 'src/dsl',
    canonicalTests: ['tests/unit/dsl/parser.test.ts'],
  },
  equivalence: {
    id: 'unit-equivalence',
    pathPrefix: 'tests/unit/equivalence',
    role: 'integration boundary',
    purpose: 'Normalized model comparison, dual execution, refinement, and event traces.',
    canonicalBoundary: 'tests/equivalence and source-neutral runtime ports',
    canonicalTests: ['tests/unit/equivalence/equivalence-harness.test.ts'],
  },
  errors: {
    id: 'unit-errors',
    pathPrefix: 'tests/unit/errors.test.ts',
    role: 'canonical unit contract',
    purpose: 'Stable typed error serialization and safe wire deserialization.',
    canonicalBoundary: 'src/errors.ts',
    canonicalTests: ['tests/unit/errors.test.ts'],
  },
  fixtures: {
    id: 'unit-fixtures',
    pathPrefix: 'tests/unit/fixtures',
    role: 'canonical unit contract',
    purpose: 'Fixture-specific authentication and data-loading contracts.',
    canonicalBoundary: 'fixture loaders and identity ports',
    canonicalTests: ['tests/unit/fixtures/crm-jwt.test.ts'],
  },
  http: {
    id: 'unit-http',
    pathPrefix: 'tests/unit/http',
    role: 'canonical unit contract',
    purpose: 'Gateway transport, response shaping, controls, security, and CORS.',
    canonicalBoundary: 'src/http',
    canonicalTests: ['tests/unit/http/responseFormat.test.ts'],
  },
  idempotency: {
    id: 'unit-idempotency',
    pathPrefix: 'tests/unit/idempotency',
    role: 'canonical unit contract',
    purpose: 'Idempotency reservation, replay, conflict, and concurrent wait semantics.',
    canonicalBoundary: 'src/idempotency',
    canonicalTests: ['tests/unit/idempotency/store.test.ts'],
  },
  identity: {
    id: 'unit-identity',
    pathPrefix: 'tests/unit/identity',
    role: 'canonical unit contract',
    purpose: 'Actor extraction, JWT, scopes, sessions, and authorization ports.',
    canonicalBoundary: 'src/identity and src/lifecycle',
    canonicalTests: ['tests/unit/identity/jwtValidator.test.ts'],
  },
  ids: {
    id: 'unit-ids',
    pathPrefix: 'tests/unit/ids',
    role: 'property invariant',
    purpose: 'UUIDv7 generation, ordering, and deterministic sources.',
    canonicalBoundary: 'src/ids',
    canonicalTests: ['tests/unit/ids/uuidv7.test.ts'],
  },
  lifecycle: {
    id: 'unit-lifecycle',
    pathPrefix: 'tests/unit/lifecycle',
    role: 'canonical unit contract',
    purpose: 'Shutdown, plugin control, and runtime lifecycle ownership.',
    canonicalBoundary: 'src/lifecycle',
    canonicalTests: ['tests/unit/lifecycle/lifecycleRuntime.test.ts'],
  },
  lint: {
    id: 'unit-lint',
    pathPrefix: 'tests/unit/lint',
    role: 'canonical unit contract',
    purpose: 'Static diagnostics and transition-model lint rules.',
    canonicalBoundary: 'src/lint',
    canonicalTests: ['tests/unit/lint/transitionModel.test.ts'],
  },
  model: {
    id: 'unit-model',
    pathPrefix: 'tests/unit/model',
    role: 'canonical unit contract',
    purpose: 'Source-neutral model builders, transitions, active learning, and refinement.',
    canonicalBoundary: 'src/model',
    canonicalTests: ['tests/unit/model/builders.test.ts'],
  },
  observability: {
    id: 'unit-observability',
    pathPrefix: 'tests/unit/observability',
    role: 'canonical unit contract',
    purpose: 'Injected logging, metrics, tracing, and runtime exchange observations.',
    canonicalBoundary: 'src/observability',
    canonicalTests: ['tests/unit/observability/dependency-injection.test.ts'],
  },
  parser: {
    id: 'unit-parser',
    pathPrefix: 'tests/unit/parser',
    role: 'canonical unit contract',
    purpose: 'YAML and AST-based TypeScript discovery/loading, watcher, and admin parsing.',
    canonicalBoundary: 'src/parser',
    canonicalTests: ['tests/unit/parser/typescriptFactoryScanner.test.ts'],
  },
  runtime: {
    id: 'unit-runtime',
    pathPrefix: 'tests/unit/runtime',
    role: 'canonical unit contract',
    purpose: 'Runtime composition roots and dependency-injected boot contracts.',
    canonicalBoundary: 'src/runtime',
    canonicalTests: ['tests/unit/runtime/bootDependencies.test.ts'],
  },
  schema: {
    id: 'unit-schema',
    pathPrefix: 'tests/unit/schema',
    role: 'canonical unit contract',
    purpose: 'OpenAPI-derived schema paths, type checking, and runtime guards.',
    canonicalBoundary: 'src/schema',
    canonicalTests: ['tests/unit/schema/typeCheck.test.ts'],
  },
  webhooks: {
    id: 'unit-webhooks',
    pathPrefix: 'tests/unit/webhooks',
    role: 'canonical unit contract',
    purpose: 'Post-commit webhook delivery and transport behavior.',
    canonicalBoundary: 'src/webhooks',
    canonicalTests: ['tests/unit/webhooks/transport.test.ts'],
  },
};

const NON_UNIT_POLICIES: readonly TestValuePolicy[] = [
  {
    id: 'runtime-parity',
    pathPrefix: 'tests/runtime',
    role: 'source parity',
    purpose: 'Direct YAML, TypeScript, and mixed source parity through the shared runtime gateway.',
    canonicalBoundary: 'src/model, src/runtime, src/core, and src/http',
    canonicalTests: ['tests/runtime/runtime-authoring-parity.runtime.test.ts'],
  },
  {
    id: 'integration',
    pathPrefix: 'tests/integration',
    role: 'integration boundary',
    purpose: 'Server, normalized equivalence, and composition-root integration boundaries.',
    canonicalBoundary: 'src/runtime, src/parser, and tests/equivalence',
    canonicalTests: ['tests/integration/server.integration.test.ts'],
  },
  {
    id: 'specmatic-e2e',
    pathPrefix: 'tests/e2e',
    role: 'real Specmatic contract',
    purpose: 'Externally observable business behavior through Specmatic JVM, plugin, and Potemkin.',
    canonicalBoundary: 'src/conformance, plugin, and src/http',
    canonicalTests: ['tests/e2e/authoring-parity.e2e-test.ts'],
  },
  {
    id: 'property',
    pathPrefix: 'tests/property',
    role: 'property invariant',
    purpose: 'Generated-value and evaluator invariants that complement example-based contracts.',
    canonicalBoundary: 'src/cel and src/ids',
    canonicalTests: ['tests/property/cel.properties.test.ts'],
  },
  {
    id: 'redteam',
    pathPrefix: 'tests/redteam',
    role: 'adversarial regression',
    purpose: 'Adversarial inputs retained as regression evidence for parser/evaluator hardening.',
    canonicalBoundary: 'src/cel and parser security boundaries',
    canonicalTests: ['tests/redteam/cel-injection.redteam.test.ts'],
  },
  {
    id: 'bdd',
    pathPrefix: 'tests/bdd',
    role: 'requirement traceability',
    purpose: 'Executable requirement scenarios and mappings to canonical tests.',
    canonicalBoundary: 'requirements.md and documented feature contracts',
    canonicalTests: ['tests/bdd/features/traceability.feature'],
  },
  {
    id: 'plugin-jvm',
    pathPrefix: 'plugin/src/test',
    role: 'integration boundary',
    purpose: 'Specmatic plugin transport, reflection, forwarding, and control-plane contracts.',
    canonicalBoundary: 'plugin/src/main and the Specmatic JVM integration',
    canonicalTests: ['plugin/src/test/kotlin/com/potemkin/specmatic/StatefulRequestHandlerTest.kt'],
  },
  {
    id: 'consumer-examples',
    pathPrefix: 'examples',
    role: 'consumer example contract',
    purpose: 'Consumer-facing Potemkin examples exercised through their public contract surfaces.',
    canonicalBoundary: 'examples/*/tests and the real Specmatic-backed example stacks',
    canonicalTests: ['examples/crm/tests/smoke.test.ts', 'examples/stripe/tests/smoke.test.ts'],
  },
];

export const TEST_VALUE_POLICIES: readonly TestValuePolicy[] = [
  ...Object.values(UNIT_POLICIES),
  ...NON_UNIT_POLICIES,
];

function relative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/');
}

export function policyForTestFile(root: string, file: string): TestValuePolicy | undefined {
  const testPath = relative(root, file);
  if (testPath.startsWith('tests/unit/')) {
    const remainder = testPath.slice('tests/unit/'.length);
    const direct = Object.values(UNIT_POLICIES).find((policy) => policy.pathPrefix === testPath);
    if (direct !== undefined) return direct;
    const directory = remainder.includes('/') ? remainder.split('/')[0]! : '__root__';
    return UNIT_POLICIES[directory] ?? UNIT_POLICIES.__root__;
  }
  return NON_UNIT_POLICIES.find(
    (policy) => testPath === policy.pathPrefix || testPath.startsWith(`${policy.pathPrefix}/`),
  );
}
