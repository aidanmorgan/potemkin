// Shared persistent-server test helper.
//
// supertest's `request(app)` opens a fresh ephemeral `app.listen(0)` server
// for every single call. Under jest's parallel workers (maxWorkers) plus the
// many simultaneous connections an integration/acceptance suite fires, this
// exhausts the OS listen backlog / ephemeral ports and surfaces as intermittent
// ECONNRESET / socket-hang-up / "Exceeded timeout" failures.
//
// withPersistentServer boots ONE `app.listen(0)` server for the whole suite and
// drives it through a supertest agent pinned to a shared keep-alive http.Agent,
// so connections are pooled across calls rather than spinning up a new server
// per request. The returned close() tears the server + agent down in afterAll.
//
// Modelled on tests/integration/parallel-requests.integration.test.ts.

import http from 'node:http';
import request from 'supertest';
import type { Express } from 'express';

/** A supertest-style agent: one method per HTTP verb, each returning a Test. */
export interface PersistentAgent {
  get(path: string): request.Test;
  post(path: string): request.Test;
  patch(path: string): request.Test;
  put(path: string): request.Test;
  delete(path: string): request.Test;
  head(path: string): request.Test;
  options(path: string): request.Test;
}

export interface PersistentServer {
  /** supertest agent bound to the running server + shared keep-alive agent. */
  readonly agent: PersistentAgent;
  /** The underlying http.Server (already listening on an ephemeral port). */
  readonly server: http.Server;
  /** Destroy the keep-alive agent and close the server. Call in afterAll. */
  close(): Promise<void>;
}

/**
 * Boot a single persistent server for `app` and return a pooled supertest agent.
 *
 * @param app Express app to listen on once.
 * @param maxSockets Upper bound on pooled sockets for the keep-alive agent.
 */
export async function withPersistentServer(
  app: Express,
  maxSockets = 64,
): Promise<PersistentServer> {
  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets });

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const agent: PersistentAgent = {
    get: (p) => request(server).get(p).agent(keepAliveAgent),
    post: (p) => request(server).post(p).agent(keepAliveAgent),
    patch: (p) => request(server).patch(p).agent(keepAliveAgent),
    put: (p) => request(server).put(p).agent(keepAliveAgent),
    delete: (p) => request(server).delete(p).agent(keepAliveAgent),
    head: (p) => request(server).head(p).agent(keepAliveAgent),
    options: (p) => request(server).options(p).agent(keepAliveAgent),
  };

  return {
    agent,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        keepAliveAgent.destroy();
        server.close(() => resolve());
      }),
  };
}
