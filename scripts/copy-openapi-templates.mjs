import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('src/openapi/templates');
const target = path.resolve('dist/src/openapi/templates');

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
