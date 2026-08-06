import express from 'express';
import request from 'supertest';
import type { RuntimeSystem } from '../../../src/runtime/system.js';
import { HttpMethod } from '../../../src/domain/references.js';
import type { RuntimeTransportObservation } from '../../../src/contracts/ports.js';
import {
  installRuntimeObservation,
  normalizeRuntimeTransportMethod,
  type RuntimeTransportRequestInput,
} from '../../../src/http/runtimeObservation.js';

function appWithTransportRequest(transportRequest: RuntimeTransportRequestInput): {
  readonly app: express.Express;
  readonly observations: RuntimeTransportObservation[];
} {
  const observations: RuntimeTransportObservation[] = [];
  const system = {
    program: {
      dependencies: {
        observability: {
          observeTransportRequestResponse: (observation: RuntimeTransportObservation): void => {
            observations.push(observation);
          },
        },
      },
    },
  } as unknown as RuntimeSystem;
  const app = express();
  installRuntimeObservation(app, system);
  app.use((_request, response) => {
    response.locals.potemkinTransportRequest = transportRequest;
    response.status(200).json({ ok: true });
  });
  return { app, observations };
}

describe('runtime transport observation method boundary', () => {
  it('normalizes supported raw methods into the shared HttpMethod vocabulary', async () => {
    const rawMethod = '  pAtCh  ';
    const { app, observations } = appWithTransportRequest({
      method: rawMethod,
      path: '/orders',
      query: {},
      headers: {},
      body: {},
    });

    await request(app).get('/outer').expect(200);

    expect(observations[0]?.request.method).toBe(HttpMethod.Patch);
  });

  it.each(['REPORT', 'CONNECT', '', '   '])('rejects unsupported method %j', (rawMethod) => {
    expect(() => normalizeRuntimeTransportMethod(rawMethod)).toThrow(/unsupported method/i);
  });
});
