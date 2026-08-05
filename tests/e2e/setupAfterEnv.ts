import { execFileSync } from 'node:child_process';
import '../setupAfterEnv.js';

// The real Specmatic-backed suite requires the JVM. A missing prerequisite is
// a setup failure for the whole run, never a reason to omit tests.
try {
  execFileSync('java', ['-version'], { stdio: 'pipe' });
} catch {
  throw new Error('The Specmatic-backed E2E suite requires Java 17+ on PATH');
}
