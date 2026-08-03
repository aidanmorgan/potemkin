import type { LintCheck } from "../types.js";
import { staticErrorBodiesCheck } from "./staticErrorBodies.js";
import { transitionModelCheck } from "./transitionModel.js";

/** All static checks applied to the canonical runtime model. */
export const ALL_CHECKS: readonly LintCheck[] = [staticErrorBodiesCheck, transitionModelCheck];

export { staticErrorBodiesCheck };
export { transitionModelCheck };
