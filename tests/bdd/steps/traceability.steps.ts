import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface TraceabilityCtx {
  requirementNumbers: number[];
  coveredNumbers: Set<number>;
  featureDir: string;
}

const CTX_KEY = '__traceability__';

Given(
  'the requirements file at {string}',
  function (this: Record<string, unknown>, reqFile: string) {
    const root = path.resolve(process.cwd());
    const reqPath = path.join(root, reqFile);

    const reqText = fs.readFileSync(reqPath, 'utf8');

    // Extract numbered requirements: lines like "1. **The System shall**..." or "41. **The System shall**..."
    const reqNumbers: number[] = [];
    const re = /^(\d+)\.\s+\*\*(?:WHEN|IF|WHILE|The System shall)/gim;

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
      `The following requirement numbers have NO matching scenario (REQ-N in title): ${missing.map(n => `REQ-${n}`).join(', ')}`,
    );
  },
);
