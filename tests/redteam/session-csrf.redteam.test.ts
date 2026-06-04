/**
 * RED TEAM — session / CSRF probes against the Potemkin session-auth gateway.
 *
 * auth.mode=session: POST /sessions to log in (sets cookie + returns CSRF token),
 * DELETE /sessions/current to log out, CSRF header required on state-changing
 * methods when a session is present.
 *
 * Each test NAME states the property; assertions encode OBSERVED behaviour.
 * Scratch red-team file — safe to delete.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: RedTeamSession, version: "1.0.0" }
paths:
  /notes/{id}:
    put:
      operationId: putNote
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Note" }
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Note" }
    post:
      operationId: createNote
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Note" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Note" }
components:
  schemas:
    Note:
      type: object
      properties:
        id: { type: string }
        text: { type: string }
      required: [id, text]
`;

const NOTE_DSL = `
boundary: Note
contract_path: /notes/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: NoteCreated
    payload_template:
      id: "command.targetId"
      text: "command.payload.text"
  - type: NoteUpdated
    payload_template:
      text: "command.payload.text"
behaviors:
  - name: create-note
    match:
      operationId: createNote
      condition: "true"
    emit: NoteCreated
  - name: update-note
    match:
      operationId: putNote
      condition: "true"
    emit: NoteUpdated
reducers:
  - on: NoteCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /text, value: "\${event.payload.text}" }
  - on: NoteUpdated
    patches:
      - { op: replace, path: /text, value: "\${event.payload.text}" }
`;

const SESSION_GLOBAL = `
auth:
  mode: session
  session:
    cookie_name: "potemkin_sid"
    ttl_seconds: 3600
    login_path: "/sessions"
    logout_path: "/sessions/current"
    csrf_header: "x-csrf-token"
`;

async function bootSession(): Promise<PersistentAgent> {
  const openapi = await loadOpenApi(OPENAPI);
  const compiledDsl = await compileDsl([{ name: 'note', yaml: NOTE_DSL }], SESSION_GLOBAL);
  const sys = await bootSystem({ openapi, compiledDsl });
  const app = createGateway(sys);
  const { agent, close } = await withPersistentServer(app);
  registerFileTeardown(close);
  return agent;
}

interface Login {
  cookie: string;
  csrf: string;
  sessionId: string;
}

async function login(agent: PersistentAgent, actorId: string, scopes: string[]): Promise<Login> {
  const res = await agent.post('/sessions').send({ actorId, scopes });
  const setCookie = res.headers['set-cookie'][0] as string;
  const cookie = setCookie.split(';')[0]; // "potemkin_sid=<id>"
  return { cookie, csrf: res.body.csrfToken, sessionId: res.body.sessionId };
}

describe('RED TEAM — session / CSRF', () => {
  // ATTACK 3a-i: state-changing request WITH a session but NO CSRF header → blocked.
  it('PUT with a live session but missing CSRF header is rejected (403)', async () => {
    const agent = await bootSession();
    const { cookie } = await login(agent, 'alice', ['note:write']);
    const id = nextUuidv7();
    const res = await agent.put(`/notes/${id}`).set('Cookie', cookie).send({ id, text: 'x' });
    // eslint-disable-next-line no-console
    console.log('[3a-i NO-CSRF] status=', res.status, 'body=', JSON.stringify(res.body));
    expect(res.status).toBe(403);
  });

  // ATTACK 3a-ii: CSRF bypass via method-override header. Some frameworks honour
  // X-HTTP-Method-Override to tunnel a GET as a mutation. Probe whether a PUT can
  // be disguised so the STATE_CHANGING set is dodged.
  it('CSRF guard cannot be bypassed with X-HTTP-Method-Override', async () => {
    const agent = await bootSession();
    const { cookie } = await login(agent, 'alice', ['note:write']);
    const id = nextUuidv7();
    // Send a real PUT but claim it's a GET via override header.
    const res = await agent
      .put(`/notes/${id}`)
      .set('Cookie', cookie)
      .set('X-HTTP-Method-Override', 'GET')
      .send({ id, text: 'pwned' });
    // eslint-disable-next-line no-console
    console.log('[3a-ii METHOD-OVERRIDE] status=', res.status);
    // The express method is still PUT → CSRF must still apply → 403.
    expect(res.status).toBe(403);
  });

  // ATTACK 3a-iii: valid CSRF header → allowed (control works).
  it('PUT with the matching CSRF header succeeds', async () => {
    const agent = await bootSession();
    const { cookie, csrf } = await login(agent, 'alice', ['note:write']);
    const id = nextUuidv7();
    // Create first so PUT (mutation) has a target.
    await agent.post(`/notes/${id}`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ id, text: 'orig' });
    const res = await agent
      .put(`/notes/${id}`)
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ id, text: 'updated' });
    // eslint-disable-next-line no-console
    console.log('[3a-iii VALID-CSRF] status=', res.status, 'body=', JSON.stringify(res.body));
    expect(res.status).toBe(200);
  });

  // ATTACK 3a-iv: CSRF token from a DIFFERENT session must not validate.
  it('CSRF token from another session does not authorise a mutation', async () => {
    const agent = await bootSession();
    const a = await login(agent, 'alice', ['note:write']);
    const b = await login(agent, 'bob', ['note:write']);
    const id = nextUuidv7();
    // alice's cookie + bob's CSRF token.
    const res = await agent
      .put(`/notes/${id}`)
      .set('Cookie', a.cookie)
      .set('x-csrf-token', b.csrf)
      .send({ id, text: 'x' });
    // eslint-disable-next-line no-console
    console.log('[3a-iv CROSS-CSRF] status=', res.status);
    expect(res.status).toBe(403);
  });

  // ATTACK 3b: session fixation — can a caller force a server to accept a
  // self-chosen session id? Login ignores any inbound cookie and mints a fresh
  // server-side UUIDv7; a forged/guessed cookie that was never issued must not
  // resolve to a session.
  it('a forged session cookie that was never issued does not resolve to any actor', async () => {
    const agent = await bootSession();
    const forgedId = nextUuidv7(); // looks like a real session id but never issued
    const id = nextUuidv7();
    // No CSRF (we have no token), but also no valid session — so this is an
    // anonymous request as far as the session layer is concerned.
    const res = await agent
      .put(`/notes/${id}`)
      .set('Cookie', `potemkin_sid=${forgedId}`)
      .send({ id, text: 'x' });
    // eslint-disable-next-line no-console
    console.log('[3b FIXATION] status=', res.status, 'body=', JSON.stringify(res.body));
    // The forged cookie resolves to NO session → request proceeds as anonymous.
    // update-note has no required_scopes, but the entity does not exist →
    // mutation on absent entity → 404. Crucially it is NOT treated as an
    // authenticated session and is NOT 200. We assert it is not a successful
    // authenticated mutation.
    expect(res.status).not.toBe(200);
  });

  // ATTACK 3b-ii: session id is server-generated, not caller-controlled.
  it('login ignores an attacker-supplied cookie and issues a fresh server session id', async () => {
    const agent = await bootSession();
    const attackerChosen = 'attacker-fixed-session-id';
    const res = await agent
      .post('/sessions')
      .set('Cookie', `potemkin_sid=${attackerChosen}`)
      .send({ actorId: 'alice', scopes: ['note:write'] });
    const setCookie = (res.headers['set-cookie'][0] as string).split(';')[0];
    // eslint-disable-next-line no-console
    console.log('[3b-ii FIXATION-LOGIN] issuedCookie=', setCookie);
    expect(setCookie).not.toContain(attackerChosen);
    expect(res.body.sessionId).not.toBe(attackerChosen);
  });

  // ATTACK 3c: logout without CSRF — documented as low-risk. Confirm scope: a
  // DELETE to the logout path with a victim's cookie but NO CSRF token destroys
  // the session (forced logout / DoS), but cannot do anything beyond that.
  it('DOCUMENTED: logout (DELETE) requires no CSRF token — a forced logout is possible', async () => {
    const agent = await bootSession();
    const { cookie, csrf } = await login(agent, 'alice', ['note:write']);

    // Forced logout: DELETE the logout path with the cookie but no CSRF header.
    const logoutRes = await agent.delete('/sessions/current').set('Cookie', cookie);
    // eslint-disable-next-line no-console
    console.log('[3c FORCED-LOGOUT] status=', logoutRes.status);
    expect(logoutRes.status).toBe(204);

    // Confirm the session is now dead: a subsequent CSRF-bearing mutation with
    // the same cookie is treated as anonymous (session gone), so its previously
    // valid CSRF token no longer matches any session → CSRF is not even reached
    // and the request proceeds anonymously (404 for absent entity), proving the
    // session was destroyed without CSRF.
    const id = nextUuidv7();
    const afterRes = await agent
      .put(`/notes/${id}`)
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ id, text: 'x' });
    // eslint-disable-next-line no-console
    console.log('[3c POST-LOGOUT] status=', afterRes.status);
    expect(afterRes.status).not.toBe(200);
  });

  // ATTACK 3e: does the CSRF token leak in any non-login response body/headers?
  it('CSRF token is not echoed in a normal mutation response body or headers', async () => {
    const agent = await bootSession();
    const { cookie, csrf } = await login(agent, 'alice', ['note:write']);
    const id = nextUuidv7();
    const res = await agent
      .post(`/notes/${id}`)
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ id, text: 'secret-note' });
    const serialized = JSON.stringify(res.body) + JSON.stringify(res.headers);
    // eslint-disable-next-line no-console
    console.log('[3e CSRF-LEAK] tokenInResponse=', serialized.includes(csrf));
    expect(serialized.includes(csrf)).toBe(false);
  });
});
