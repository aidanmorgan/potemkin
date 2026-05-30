// TypeScript reducer for (Widget, WidgetCreated). Registered via the
// @potemkin/sdk function-style helper. Returns the canonical Patch[] that the
// engine applies through the same applyPatches path as YAML reducers.
import { reducer, replace, add } from '@potemkin/sdk';

interface WidgetCreatedEvent {
  payload: { id: string; name: string };
}

export const onWidgetCreated = reducer(
  { boundary: 'Widget', event: 'WidgetCreated' },
  (_state, event, _ctx) => {
    const e = event as WidgetCreatedEvent;
    return [
      replace('/id', e.payload.id),
      replace('/name', e.payload.name),
      add('/status', 'ACTIVE'),
      add('/renameCount', 0),
    ];
  },
  'scripts/widgetCreated.ts',
);
