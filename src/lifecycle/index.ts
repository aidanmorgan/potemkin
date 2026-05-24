/**
 * Lifecycle barrel — re-exports public lifecycle API.
 */

export type {
  PluginControlConfig,
  PluginControlClient,
  ReadyNotification,
  ShutdownNotification,
  NotifyResult,
} from './types.js';

export { createPluginControlClient } from './pluginControlClient.js';

export type { GracefulShutdownConfig } from './gracefulShutdown.js';
export { installGracefulShutdown } from './gracefulShutdown.js';
