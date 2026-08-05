import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function typescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) files.push(...typescriptFiles(file));
    else if (/\.(ts|tsx)$/.test(file)) files.push(file);
  }
  return files;
}

describe('module boundary policy', () => {
  it('does not use export-from re-export declarations', () => {
    const roots = [path.resolve(__dirname, '../../../src'), path.resolve(__dirname, '../../')];
    const violations = roots
      .flatMap((root) => typescriptFiles(root))
      .filter((file) => {
        const source = ts.createSourceFile(
          file,
          readFileSync(file, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        return source.statements.some(
          (statement) =>
            ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined,
        );
      });

    expect(violations).toEqual([]);
  });
});
