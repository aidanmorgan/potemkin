// TypeScript reducer for (Widget, WidgetCreated) registered via the @Reducer
// class-decorator style (the second of the two SDK registration styles; the
// function-style reducer() helper is exercised by the ts-reducer fixture).
//
// The Widget boundary declares NO YAML reducer for WidgetCreated, so this
// decorator owns the projection: it sets status=ACTIVE and renameCount=0,
// identical to the helper-style reducer, proving both styles fire end-to-end.
import { Reducer, replace, add, type Patch, type ReducerContext } from '@potemkin/sdk';

interface WidgetCreatedEvent {
  payload: { id: string; name: string };
}

@Reducer({ boundary: 'Widget', event: 'WidgetCreated' })
export class OnWidgetCreated {
  apply(_state: unknown, event: unknown, _ctx: ReducerContext): Patch[] {
    const e = event as WidgetCreatedEvent;
    return [
      replace('/id', e.payload.id),
      replace('/name', e.payload.name),
      add('/status', 'ACTIVE'),
      add('/renameCount', 0),
    ];
  }
}
