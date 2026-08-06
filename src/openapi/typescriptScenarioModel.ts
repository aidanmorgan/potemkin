import * as ts from 'typescript';

import type {
  ScenarioComponentModel,
  ScenarioEventModel,
  ScenarioFieldType,
  ScenarioResourceModel,
  ScenarioSourceLocation,
} from './scenarioModel.js';

export function extractTypeScriptEvents(
  source: string,
  fileName: string,
): readonly ScenarioEventModel[] {
  const script = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const events: ScenarioEventModel[] = [];
  const eventDeclarations = new Map<string, ScenarioEventModel>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const declaration = ts.isCallExpression(node.initializer)
        ? calledName(node.initializer.expression) === 'event'
          ? eventFromCall(node.initializer)
          : calledName(node.initializer.expression) === 'defineEvent'
            ? eventFromDefinition(node.initializer)
            : undefined
        : undefined;
      if (declaration !== undefined) eventDeclarations.set(node.name.text, declaration);
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (name === 'event') {
        const extracted = eventFromCall(node);
        if (extracted !== undefined) events.push(extracted);
      } else if (name === 'defineEvent') {
        const extracted = eventFromDefinition(node);
        if (extracted !== undefined) events.push(extracted);
      } else if (name === 'eventType' && isEventTypeDeclaration(node)) {
        const type = stringLiteral(node.arguments[0]);
        if (type !== undefined) {
          events.push({
            boundary: '',
            type,
            fields: [],
            sourcePath: fileName,
            location: locationForNode(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(script);

  const composedEvents: ScenarioEventModel[] = [];
  const visitComposition = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calledName(node.expression) === 'boundary') {
      const boundary = staticAuthoringName(node.arguments[0], 'boundaryName');
      if (boundary !== undefined) {
        for (const argument of chainedMethodArguments(node, 'eventCatalog')) {
          const declaration = ts.isIdentifier(argument)
            ? eventDeclarations.get(argument.text)
            : ts.isCallExpression(argument)
              ? calledName(argument.expression) === 'event'
                ? eventFromCall(argument)
                : calledName(argument.expression) === 'defineEvent'
                  ? eventFromDefinition(argument)
                  : undefined
              : undefined;
          if (declaration !== undefined) composedEvents.push({ ...declaration, boundary });
        }
      }
    }
    ts.forEachChild(node, visitComposition);
  };
  visitComposition(script);
  return [...events, ...composedEvents];
}

export function extractTypeScriptDefinitions(
  source: string,
  fileName: string,
): {
  readonly components: readonly ScenarioComponentModel[];
  readonly resources: readonly ScenarioResourceModel[];
} {
  const script = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const components: ScenarioComponentModel[] = [];
  const resources: ScenarioResourceModel[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (name === 'defineComponent') {
        const componentName = staticAuthoringName(node.arguments[0], 'componentName');
        if (componentName !== undefined) {
          const sourceObject = node.arguments[1];
          components.push({
            name: componentName,
            sourcePath: fileName,
            includes: [],
            uses: [],
            eventTypes: collectWrappedStringCalls(sourceObject, 'eventType'),
            reducerEventTypes: collectWrappedStringCalls(sourceObject, 'eventType'),
            behaviorNames: collectWrappedStringCalls(sourceObject, 'behaviorName'),
            sourceLocation: locationForNode(node),
          });
        }
      } else if (name === 'defineResource') {
        const resourceName = staticAuthoringName(node.arguments[0], 'resourceName');
        if (resourceName !== undefined) {
          const sourceObject = node.arguments[1];
          resources.push({
            name: resourceName,
            schema: collectWrappedStringCalls(sourceObject, 'schemaReference')[0] ?? resourceName,
            operationIds: collectWrappedStringCalls(sourceObject, 'operationId'),
            sourcePath: fileName,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(script);
  return { components, resources };
}

function chainedMethodArguments(
  root: ts.CallExpression,
  methodName: string,
): readonly ts.Expression[] {
  const argumentsFound: ts.Expression[] = [];
  let current: ts.Node = root;
  while (current.parent !== undefined) {
    const access = current.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== current) break;
    const call = access.parent;
    if (!ts.isCallExpression(call) || call.expression !== access) break;
    if (access.name.text === methodName) argumentsFound.push(...call.arguments);
    current = call;
  }
  return argumentsFound;
}

function staticAuthoringName(node: ts.Expression | undefined, wrapper: string): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isCallExpression(node) && calledName(node.expression) === wrapper) {
    return stringLiteral(node.arguments[0]);
  }
  return undefined;
}

function collectWrappedStringCalls(node: ts.Node | undefined, wrapper: string): readonly string[] {
  if (node === undefined) return [];
  const values: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && calledName(current.expression) === wrapper) {
      const value = stringLiteral(current.arguments[0]);
      if (value !== undefined) values.push(value);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...new Set(values)].sort();
}

function isEventTypeDeclaration(node: ts.CallExpression): boolean {
  return (
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node &&
    ts.isIdentifier(node.parent.name)
  );
}

function eventFromCall(node: ts.CallExpression): ScenarioEventModel | undefined {
  const typeExpression = node.arguments[0];
  if (
    !ts.isCallExpression(typeExpression) ||
    calledName(typeExpression.expression) !== 'eventType'
  ) {
    return undefined;
  }
  const type = stringLiteral(typeExpression.arguments[0]);
  if (type === undefined) return undefined;
  return {
    boundary: '',
    type,
    fields: objectKeys(node.arguments[1]),
    fieldTypes: objectFieldTypes(node.arguments[1]),
    sourcePath: fileNameForNode(node),
    location: locationForNode(node),
  };
}

function eventFromDefinition(node: ts.CallExpression): ScenarioEventModel | undefined {
  const object = node.arguments[0];
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const typeProperty = property(object, 'type');
  const typeCall = typeProperty?.initializer;
  if (
    !typeCall ||
    !ts.isCallExpression(typeCall) ||
    calledName(typeCall.expression) !== 'eventType'
  ) {
    return undefined;
  }
  const type = stringLiteral(typeCall.arguments[0]);
  if (type === undefined) return undefined;
  const payload = property(object, 'payload')?.initializer;
  return {
    boundary: '',
    type,
    fields: objectKeys(payload),
    fieldTypes: objectFieldTypes(payload),
    sourcePath: fileNameForNode(node),
    location: locationForNode(node),
  };
}

function fileNameForNode(node: ts.Node): string | undefined {
  return node.getSourceFile().fileName;
}

function locationForNode(node: ts.Node): ScenarioSourceLocation {
  const source = node.getSourceFile();
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    sourcePath: source.fileName,
    start: { line: start.line, column: start.character, offset: node.getStart(source) },
    end: { line: end.line, column: end.character, offset: node.getEnd() },
  };
}

function calledName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;
}

function objectKeys(node: ts.Node | undefined): readonly string[] {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((entry) => {
    if (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) return [];
    const name = entry.name;
    if (name === undefined) return [];
    return [ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined].filter(
      (value): value is string => value !== undefined,
    );
  });
}

function objectFieldTypes(node: ts.Node | undefined): Readonly<Record<string, ScenarioFieldType>> {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return {};
  return Object.fromEntries(
    node.properties.flatMap((entry) => {
      if (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) return [];
      const name = entry.name;
      const key =
        name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))
          ? name.text
          : undefined;
      if (key === undefined) return [];
      return [
        [key, inferTypeScriptType(ts.isPropertyAssignment(entry) ? entry.initializer : undefined)],
      ] as const;
    }),
  );
}

function inferTypeScriptType(node: ts.Node | undefined): ScenarioFieldType {
  if (node === undefined) return 'unknown';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return 'string';
  if (ts.isNumericLiteral(node)) return 'number';
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
    return 'boolean';
  if (ts.isArrayLiteralExpression(node)) return 'array';
  if (ts.isObjectLiteralExpression(node)) return 'object';
  return 'unknown';
}

function property(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return node.properties.find((entry): entry is ts.PropertyAssignment => {
    if (!ts.isPropertyAssignment(entry)) return false;
    const propertyName = entry.name;
    return (
      propertyName !== undefined && ts.isIdentifier(propertyName) && propertyName.text === name
    );
  });
}
