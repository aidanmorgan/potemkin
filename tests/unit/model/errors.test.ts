import { StructuredError } from '../../../src/errors.js';
import { RuntimeModelError } from '../../../src/model/errors.js';

describe('runtime model diagnostics', () => {
  it('uses the shared structured error mechanics without changing its contract', () => {
    const error = new RuntimeModelError('RUNTIME_BOUNDARY_CONFLICT', 'boundary already exists', {
      boundary: 'Customer',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StructuredError);
    expect(error).toBeInstanceOf(RuntimeModelError);
    expect(error.name).toBe('RuntimeModelError');
    expect(error.code).toBe('RUNTIME_BOUNDARY_CONFLICT');
    expect(error.toJSON()).toEqual({
      name: 'RuntimeModelError',
      code: 'RUNTIME_BOUNDARY_CONFLICT',
      message: 'boundary already exists',
      details: { boundary: 'Customer' },
    });
  });

  it('omits absent details from the diagnostic wire shape', () => {
    const error = new RuntimeModelError('RUNTIME_BUILDER_INVALID', 'invalid builder');

    expect(error.toJSON()).toEqual({
      name: 'RuntimeModelError',
      code: 'RUNTIME_BUILDER_INVALID',
      message: 'invalid builder',
    });
  });
});
