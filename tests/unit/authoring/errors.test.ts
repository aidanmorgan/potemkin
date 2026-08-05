import {
  TypeScriptAuthoringError,
  definitionError,
  helperError,
  isTypeScriptAuthoringError,
} from '../../../src/authoring/errors.js';

describe('TypeScript authoring diagnostics', () => {
  it('exposes a stable code, structured details, and source location', () => {
    const error = new TypeScriptAuthoringError('TS_DEFINITION_INVALID', 'bad definition', {
      details: { field: 'boundary' },
      source: { source: 'scenario.ts', line: 12, column: 4 },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TypeScriptAuthoringError);
    expect(error.code).toBe('TS_DEFINITION_INVALID');
    expect(error.details).toEqual({ field: 'boundary' });
    expect(error.location).toEqual({ source: 'scenario.ts', line: 12, column: 4 });
    expect(error.toJSON()).toEqual({
      name: 'TypeScriptAuthoringError',
      code: 'TS_DEFINITION_INVALID',
      message: 'bad definition',
      details: { field: 'boundary' },
      location: { source: 'scenario.ts', line: 12, column: 4 },
    });
  });

  it('provides typed constructors for SDK validation categories', () => {
    expect(definitionError('invalid').code).toBe('TS_DEFINITION_INVALID');
    expect(helperError('invalid').code).toBe('TS_HELPER_INVALID');
  });

  it('narrows unknown failures without relying on message matching', () => {
    const error: unknown = helperError('invalid');
    expect(isTypeScriptAuthoringError(error)).toBe(true);
    if (isTypeScriptAuthoringError(error)) expect(error.code).toBe('TS_HELPER_INVALID');
    expect(isTypeScriptAuthoringError(new Error('invalid'))).toBe(false);
  });
});
