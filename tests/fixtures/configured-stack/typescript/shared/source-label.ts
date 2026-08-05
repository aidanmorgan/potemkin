import { defineHelper, helperName } from 'potemkin/sdk';

/** The same callable is used by TypeScript and registered for YAML CEL. */
export const sourceLabel = defineHelper(
  helperName('sourceLabel'),
  (source: string): string => source,
);
