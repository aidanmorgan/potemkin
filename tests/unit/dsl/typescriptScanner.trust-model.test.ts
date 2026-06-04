/**
 * TRUST MODEL CHARACTERIZATION — typescriptScanner (@Script / @Reducer files).
 *
 * The vm context in typescriptScanner.ts is NOT a security boundary. Scanned
 * files execute as TRUSTED host code sourced from the same version-controlled
 * repository. The static checks (FORBIDDEN_BUILTINS, ENV_WRITE_PATTERNS) guard
 * against accidental mistakes, not against malicious code.
 *
 * This test asserts that the escape IS reachable: a scanned file CAN walk the
 * prototype chain to the host realm via `Object.constructor('return process')()`.
 * Its purpose is two-fold:
 *
 *   1. Document the deliberate trust model so readers know the vm context offers
 *      no isolation guarantee.
 *   2. Act as a canary — if someone later introduces real vm isolation (e.g.
 *      vm.SyntheticModule, isolated-vm, a Worker thread sandbox), this test will
 *      FAIL, prompting them to update the trust-model documentation and confirm
 *      the security boundary is intentional.
 *
 * If you are reading this after a failed test: the escape is no longer reachable,
 * which is a behaviour change. Update the TRUST MODEL comment in typescriptScanner.ts,
 * the trust-model docs, and flip this assertion accordingly.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { scanTypescriptReducers } from '../../../src/dsl/typescriptScanner.js';
import { scriptRegistry } from '../../../src/sdk/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-trust-model-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

beforeEach(() => {
  scriptRegistry.resetSync();
});

afterEach(() => {
  scriptRegistry.resetSync();
});

// ---------------------------------------------------------------------------

describe('typescriptScanner — trusted-code trust model', () => {
  it('@Script CAN reach the host process via Object.constructor prototype walk', async () => {
    // This escape works because the vm context is initialised with the HOST realm's
    // Object (see typescriptScanner.ts vm.createContext({ ..., Object, ... })).
    // Object.constructor is therefore the host Function constructor, and calling
    // it as a string-eval back-door produces a function that executes in the host
    // realm and can return host globals.
    let captured: unknown;
    (globalThis as Record<string, unknown>).__trustModelCapture = (v: unknown) => {
      captured = v;
    };

    const root = await makeTree({
      'probe.ts': `
        const F = (Object as any).constructor;
        const hostProcess = F('return process')();
        const hostGlobal = F('return globalThis')();
        if (hostGlobal && hostGlobal.__trustModelCapture) {
          hostGlobal.__trustModelCapture({
            pid: hostProcess && hostProcess.pid,
            type: typeof hostProcess,
          });
        }
      `,
    });

    try {
      await scanTypescriptReducers(
        { scan: [{ include: ['*.ts'] }] },
        { cwd: root },
      );
    } catch {
      // The scan may throw (no @Script/@Reducer registration) — that is fine;
      // what matters is whether the probe ran and captured.
    } finally {
      delete (globalThis as Record<string, unknown>).__trustModelCapture;
      fs.rmSync(root, { recursive: true, force: true });
    }

    // The probe must have run and reached the real host process.
    // If this assertion fails the vm context now isolates the host realm —
    // see the file header comment for what to do.
    expect(captured).toBeDefined();
    expect((captured as Record<string, unknown>)['type']).toBe('object');
    expect(typeof (captured as Record<string, unknown>)['pid']).toBe('number');
    expect((captured as Record<string, unknown>)['pid']).toBe(process.pid);
  });
});
