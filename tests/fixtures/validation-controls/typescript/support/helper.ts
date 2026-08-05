import {
  PotemkinConfigure,
  defineHelper,
  factoryName,
  helperName,
  simulation,
  type JsonObject,
} from 'potemkin/sdk';

const addUnexpectedProfileField = defineHelper(
  helperName('addUnexpectedProfileField'),
  (input: JsonObject): JsonObject => {
    const response = input['response'];
    const responseObject =
      response !== null && typeof response === 'object' && !Array.isArray(response)
        ? (response as JsonObject)
        : {};
    const body = responseObject['body'];
    const bodyObject =
      body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as JsonObject) : {};
    return { body: { ...bodyObject, unexpected: 'response-transform' } };
  },
);

export class ValidationControlHelperFactory {
  @PotemkinConfigure(factoryName('validation-control-helper'))
  static create() {
    return simulation().helper(addUnexpectedProfileField).build();
  }
}
