import {
  expandPotemkinAliases,
  POTEMKIN_REQUEST_HEADERS,
  POTEMKIN_SIGNAL,
} from '../../../src/http/potemkinHeaders.js';

describe('Potemkin transport control header registry', () => {
  it('expands known controls and reports unknown controls without dropping them silently', () => {
    expect(
      expandPotemkinAliases({ signal: 'rate_limit', response_format: 'hal', unknown: 'x' }),
    ).toEqual({
      headers: {
        [POTEMKIN_SIGNAL]: 'rate_limit',
        'x-potemkin-response-format': 'hal',
      },
      unknown: ['unknown'],
    });
    expect(POTEMKIN_REQUEST_HEADERS).toContain(POTEMKIN_SIGNAL);
  });
});
