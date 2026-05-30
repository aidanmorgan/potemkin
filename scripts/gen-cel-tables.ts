/**
 * Codegen: build the LALR(1) parse tables from the CEL grammar and write them
 * to src/cel/grammar/tables.generated.ts. The generated file is committed; the
 * runtime parser imports it directly so there is NO runtime code generation.
 *
 * Run with:  npx tsx scripts/gen-cel-tables.ts
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTables } from '../src/cel/grammar/lalr.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'src', 'cel', 'grammar', 'tables.generated.ts');

const tables = buildTables();

const banner = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * LALR(1) ACTION/GOTO tables for the CEL grammar, produced from
 * src/cel/grammar/grammar.ts by scripts/gen-cel-tables.ts. Regenerate with:
 *   npx tsx scripts/gen-cel-tables.ts
 *
 * Production indices match the PRODUCTIONS array in grammar.ts (and the reduce
 * actions in parser.ts). States: ${tables.stateCount}.
 */

import type { ParseTables } from './lalr.js';
`;

const body = `\nexport const TABLES: ParseTables = ${JSON.stringify(tables, null, 1)};\n`;

writeFileSync(outPath, banner + body, 'utf8');
// eslint-disable-next-line no-console
console.log(`Wrote ${outPath} (${tables.stateCount} states)`);
