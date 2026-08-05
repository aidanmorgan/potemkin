import * as ts from 'typescript';

const FACTORY_MODULE = 'potemkin/sdk';
const FACTORY_DECORATOR = 'PotemkinConfigure';

/**
 * Determine whether a source file contains a real static factory decorator.
 * This is deliberately syntax-aware: comments, strings, instance methods, and
 * unrelated decorators cannot make a file an executable factory entrypoint.
 */
export function hasPotemkinConfigureDecorator(source: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const localNames = importedFactoryNames(sourceFile);
  if (localNames.size === 0) return false;

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !hasStaticModifier(member)) continue;
      const decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
      if (decorators?.some((decorator) => isFactoryDecorator(decorator, localNames)) === true) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The historical independently-scanned reducer decorator is intentionally not
 * part of the canonical factory API. Detect it at discovery time so a stale
 * source file gets an actionable migration diagnostic instead of being
 * silently ignored by the factory scanner.
 */
export function hasRemovedReducerScannerSyntax(source: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportSpecifier(node) && node.name.text === 'PotemkinReducer') {
      found = true;
      return;
    }
    if (ts.isDecorator(node)) {
      const expression = ts.isCallExpression(node.expression)
        ? node.expression.expression
        : node.expression;
      if (ts.isIdentifier(expression) && expression.text === 'PotemkinReducer') {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function importedFactoryNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== FACTORY_MODULE
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.propertyName === undefined && element.name.text === FACTORY_DECORATOR) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function isFactoryDecorator(decorator: ts.Decorator, localNames: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(decorator.expression)) return false;
  const target = decorator.expression.expression;
  return ts.isIdentifier(target) && localNames.has(target.text);
}

function hasStaticModifier(method: ts.MethodDeclaration): boolean {
  const modifiers = ts.canHaveModifiers(method) ? ts.getModifiers(method) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.js')) return ts.ScriptKind.JS;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}
