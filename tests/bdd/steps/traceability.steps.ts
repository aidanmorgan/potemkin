import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface TraceabilityCtx {
  requirementNumbers: number[];
  coveredNumbers: Set<number>;
  featureDir: string;
}

const parityEvidence: Readonly<Record<number, readonly string[]>> = {
  48: ['tests/runtime/runtime-authoring-parity.runtime.test.ts'],
  49: [
    'tests/unit/authoring/canonicalModel.test.ts',
    'tests/unit/authoring/typescriptAuthoring.test.ts',
  ],
  50: ['tests/unit/authoring/composition.test.ts', 'tests/unit/authoring/runtimeParity.test.ts'],
  51: ['tests/runtime/runtime-specmatic-surface.runtime.test.ts'],
  52: ['tests/unit/authoring/typescriptAuthoring.test.ts'],
  53: ['tests/runtime/runtime-authoring-parity.runtime.test.ts'],
  54: ['tests/unit/authoring/typescriptAuthoring.test.ts'],
  55: ['tests/unit/model/builders.test.ts'],
  56: ['tests/unit/authoring/runtimeParity.test.ts'],
  57: ['tests/unit/core/import-boundary.test.ts'],
  58: ['tests/runtime/authoring-typescript.runtime.test.ts'],
  59: ['tests/runtime/authoring-http-parity.runtime.test.ts'],
  60: ['tests/unit/model/builders.test.ts', 'tests/unit/authoring/typescriptAuthoring.test.ts'],
  61: ['tests/runtime/runtime-seeded-parity.runtime.test.ts'],
  62: ['tests/runtime/runtime-response-shaping.runtime.test.ts'],
  63: ['tests/runtime/runtime-composition.runtime.test.ts'],
  64: ['tests/runtime/runtime-response-shaping.runtime.test.ts'],
  65: ['tests/runtime/runtime-ttl.runtime.test.ts'],
  66: ['tests/runtime/runtime-direct-chaos.runtime.test.ts'],
  67: ['tests/runtime/runtime-composition.runtime.test.ts'],
  68: [
    'tests/unit/authoring/lifecycle.test.ts',
    'tests/integration/authoring-parity-trace.integration.test.ts',
  ],
  69: ['tests/unit/authoring/helpers.test.ts', 'tests/e2e/configured-source-matrix.e2e-test.ts'],
  70: ['tests/runtime/runtime-authoring-parity.runtime.test.ts'],
  71: ['tests/runtime/runtime-otel.runtime.test.ts'],
  72: ['tests/unit/equivalence/equivalence-harness.test.ts'],
  73: [
    'tests/unit/authoring/runtimeParity.test.ts',
    'tests/integration/authoring-parity-trace.integration.test.ts',
  ],
  74: ['tests/unit/authoring/typescriptAuthoring.test.ts'],
  75: ['tests/bdd/features/typescript-parity.feature'],
  76: ['tests/runtime/runtime-otel.runtime.test.ts', 'tests/e2e/runtime-observability.e2e-test.ts'],
  77: ['tests/runtime/runtime-authoring-parity.runtime.test.ts'],
  78: ['tests/runtime/pure-authoring-observables.runtime.test.ts'],
  79: ['tests/runtime/runtime-seeded-parity.runtime.test.ts'],
  80: [
    'tests/runtime/runtime-composition.runtime.test.ts',
    'tests/runtime/runtime-derived-projection.runtime.test.ts',
    'tests/e2e/webhook-hmac.e2e-test.ts',
  ],
  81: ['tests/runtime/runtime-response-shaping.runtime.test.ts'],
  82: ['tests/runtime/runtime-direct-chaos.runtime.test.ts'],
  83: ['tests/runtime/runtime-direct-chaos.runtime.test.ts'],
  84: ['tests/runtime/runtime-latency-parity.runtime.test.ts'],
  85: ['tests/runtime/runtime-ttl.runtime.test.ts'],
  86: [
    'tests/unit/parser/typescriptFactoryScanner.test.ts',
    'tests/e2e/configured-source-matrix.e2e-test.ts',
  ],
  87: ['tests/runtime/runtime-time-travel.runtime.test.ts'],
  88: ['tests/runtime/runtime-controls.runtime.test.ts'],
  89: ['tests/runtime/runtime-specmatic-surface.runtime.test.ts'],
  90: ['tests/runtime/runtime-specmatic-surface.runtime.test.ts'],
  91: ['tests/runtime/runtime-reload.runtime.test.ts'],
  92: ['tests/runtime/authoring-http-parity.runtime.test.ts'],
  93: ['tests/runtime/pure-authoring-observables.runtime.test.ts'],
  94: ['tests/e2e/configured-source-matrix.e2e-test.ts'],
  95: ['tests/unit/audit/sourceTree.test.ts'],
  96: ['tests/unit/audit/dependencyBoundaries.test.ts', 'tests/unit/authoring/errors.test.ts'],
  97: ['tests/unit/audit/dependencyBoundaries.test.ts', 'tests/unit/authoring/errors.test.ts'],
  98: ['tests/unit/audit/testValueTraceability.test.ts', 'tests/unit/audit/sourceTree.test.ts'],
  99: [
    'tests/unit/core/import-boundary.test.ts',
    'tests/unit/core/no-reexports.test.ts',
    'tests/unit/audit/dependencyBoundaries.test.ts',
  ],
};

const CTX_KEY = '__traceability__';

Given(
  'the requirements file at {string}',
  function (this: Record<string, unknown>, reqFile: string) {
    const root = path.resolve(process.cwd());
    const reqPath = path.join(root, reqFile);

    const reqText = fs.readFileSync(reqPath, 'utf8');

    // Extract numbered requirements and backlog tasks from requirements.md.
    const reqNumbers: number[] = [];
    const re = /^(\d+)\.\s+\*\*(?:WHEN|IF|WHILE|The System shall|Backlog task)/gim;

    let m: RegExpExecArray | null;
    while ((m = re.exec(reqText)) !== null) {
      reqNumbers.push(parseInt(m[1], 10));
    }

    reqNumbers.sort((a, b) => a - b);

    this[CTX_KEY] = {
      requirementNumbers: reqNumbers,
      coveredNumbers: new Set<number>(),
      featureDir: '',
    } as TraceabilityCtx;
  },
);

When(
  'I scan the features under {string}',
  function (this: Record<string, unknown>, featuresDir: string) {
    const ctx = this[CTX_KEY] as TraceabilityCtx;
    const root = path.resolve(process.cwd());
    const fullDir = path.join(root, featuresDir);

    const covered = new Set<number>();

    function scanDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.feature')) {
          const text = fs.readFileSync(fullPath, 'utf8');
          const reqRe = /REQ-(\d+)/g;
          let m: RegExpExecArray | null;
          while ((m = reqRe.exec(text)) !== null) {
            covered.add(parseInt(m[1], 10));
          }
        }
      }
    }

    scanDir(fullDir);
    ctx.coveredNumbers = covered;
    ctx.featureDir = fullDir;
    this[CTX_KEY] = ctx;
  },
);

Then(
  'every requirement number from {int} to {int} should match at least one scenario title',
  function (this: Record<string, unknown>, from: number, to: number) {
    const ctx = this[CTX_KEY] as TraceabilityCtx;

    const missing: number[] = [];
    for (let i = from; i <= to; i++) {
      if (!ctx.coveredNumbers.has(i)) {
        missing.push(i);
      }
    }

    assert.strictEqual(
      missing.length,
      0,
      `The following requirement numbers have NO matching scenario (REQ-N in title): ${missing.map((n) => `REQ-${n}`).join(', ')}`,
    );
  },
);

Then('parity requirement {int} has an executable test', function (requirementNumber: number) {
  const targets = parityEvidence[requirementNumber];
  assert.ok(targets !== undefined, `No evidence mapping exists for REQ-${requirementNumber}`);
  for (const target of targets) {
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), target)),
      `Evidence target does not exist: ${target}`,
    );
  }
});
