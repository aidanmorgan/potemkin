export type {
  SchemaTypeKind,
  ObjectGraphSchema,
  BoundarySchemas,
  ObjectGraphSchemaRegistry,
} from './types.js';

export { deriveSchemasFromOpenApi } from './fromOpenApi.js';

export {
  resolvePath,
  isValidPath,
  pathExists,
} from './pathResolver.js';

export {
  typeOfJson,
  isAssignable,
  validateEntityAgainstSchema,
} from './typeCheck.js';

export { staticCheckDsl } from './dslStaticChecker.js';
export type { DslCheckError } from './dslStaticChecker.js';

export {
  guardAssignPath,
  guardAssignedValue,
} from './runtimeGuard.js';
