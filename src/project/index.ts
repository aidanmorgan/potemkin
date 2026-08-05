import { compileProject, loadProjectSources } from './compiler.js';
import type { ProjectCompilationContext } from './compiler.js';
import { loadProjectDescriptor } from './descriptor.js';
import type { ProjectDescriptor, ProjectDescriptorOptions } from './descriptor.js';

export { compileProject, loadProjectSources, loadProjectDescriptor };
export type { ProjectCompilationContext, ProjectDescriptor, ProjectDescriptorOptions };
