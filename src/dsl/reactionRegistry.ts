import { BootError } from '../errors.js';
import type { BoundaryConfig, ReactionRule, ReactionsByTrigger } from './types.js';

/** Build the source-neutral lookup used by the YAML linker and authoring validator. */
export function buildReactionRegistry(allReactions: readonly ReactionRule[]): ReactionsByTrigger {
  const map = new Map<string, ReactionRule[]>();
  for (const reaction of allReactions) {
    const bucket = map.get(reaction.on) ?? [];
    bucket.push(reaction);
    map.set(reaction.on, bucket);
  }
  return map as ReactionsByTrigger;
}

/** Validate reaction targets and event subscriptions after composition is complete. */
export function validateReactionCrossReferences(
  allReactions: readonly ReactionRule[],
  byBoundaryName: Record<string, BoundaryConfig>,
): void {
  const allEventTypes = new Map<string, string[]>();
  for (const [boundaryName, boundary] of Object.entries(byBoundaryName)) {
    for (const event of boundary.eventCatalog) {
      const names = allEventTypes.get(event.type) ?? [];
      names.push(boundaryName);
      allEventTypes.set(event.type, names);
    }
  }

  for (const reaction of allReactions) {
    const boundaryName = reaction.boundary!;
    const label =
      reaction.name === undefined ? `reaction on "${reaction.on}"` : `reaction "${reaction.name}"`;
    const target = byBoundaryName[boundaryName];
    if (target === undefined) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `${label}: reacting boundary "${boundaryName}" is not a known boundary`,
        { reaction: reaction.name ?? reaction.on, boundary: boundaryName },
      );
    }
    if (!target.eventCatalog.some((event) => event.type === reaction.emit)) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `${label}: "emit" event type "${reaction.emit}" is not in boundary "${boundaryName}" event_catalog`,
        {
          reaction: reaction.name ?? reaction.on,
          boundary: boundaryName,
          missingType: reaction.emit,
        },
      );
    }
    if (reaction.on.includes(':')) {
      const [triggerBoundaryName, triggerEventType] = reaction.on.split(':', 2) as [string, string];
      const triggerBoundary = byBoundaryName[triggerBoundaryName];
      if (triggerBoundary === undefined) {
        throw new BootError(
          'BOOT_ERR_DSL_REFERENCE',
          `${label}: trigger "on" boundary "${triggerBoundaryName}" (in "${reaction.on}") is not a known boundary`,
          {
            reaction: reaction.name ?? reaction.on,
            triggerBoundary: triggerBoundaryName,
            on: reaction.on,
          },
        );
      }
      if (!triggerBoundary.eventCatalog.some((event) => event.type === triggerEventType)) {
        throw new BootError(
          'BOOT_ERR_DSL_REFERENCE',
          `${label}: trigger event type "${triggerEventType}" is not in boundary "${triggerBoundaryName}" event_catalog (on: "${reaction.on}")`,
          {
            reaction: reaction.name ?? reaction.on,
            triggerBoundary: triggerBoundaryName,
            missingType: triggerEventType,
            on: reaction.on,
          },
        );
      }
    } else if (!allEventTypes.has(reaction.on)) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `${label}: trigger event type "${reaction.on}" is not found in any boundary's event_catalog`,
        { reaction: reaction.name ?? reaction.on, missingType: reaction.on, on: reaction.on },
      );
    }
  }
}
