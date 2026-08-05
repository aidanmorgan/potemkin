import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

interface JsonRpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly params?: Record<string, unknown>;
}

describe('language-server stdio protocol', () => {
  it('initializes, publishes diagnostics, completes, and regenerates artifacts after didChange', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-language-server-protocol-'));
    await writeProject(root);
    const server = spawn(
      path.resolve('node_modules/.bin/tsx'),
      [path.resolve('src/language-server/server.ts')],
      {
        cwd: root,
        env: { ...process.env, LOG_LEVEL: 'silent' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const rpc = jsonRpcClient(server);
    const yamlPath = path.join(root, 'agent.yaml');
    const yamlUri = pathToFileURL(yamlPath).toString();
    try {
      const initialYaml = yamlModule('YamlCreated').replace(
        'emit: YamlCreated',
        'emit: MissingEvent',
      );
      await fs.writeFile(yamlPath, yamlModule('YamlCreated'), 'utf8');

      rpc.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          processId: process.pid,
          rootUri: pathToFileURL(root).toString(),
          capabilities: {},
          initializationOptions: { configPath: 'potemkin.yml' },
          workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: 'protocol-test' }],
        },
      });
      const initialized = await rpc.response(1);
      expect(initialized.result).toEqual(
        expect.objectContaining({
          capabilities: expect.objectContaining({
            completionProvider: expect.any(Object),
            definitionProvider: true,
            renameProvider: true,
          }),
        }),
      );

      rpc.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      rpc.send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: { uri: yamlUri, languageId: 'yaml', version: 1, text: initialYaml },
        },
      });

      const initialDiagnostics = await rpc.notification('textDocument/publishDiagnostics');
      expect(diagnosticMessages(initialDiagnostics)).toContain(
        'Unknown scenario event "MissingEvent"',
      );
      // TextDocuments emits both didOpen and didChangeContent for an open.
      await rpc.notification('textDocument/publishDiagnostics');
      await expectGenerated(root, 'YamlCreated');

      rpc.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'textDocument/completion',
        params: {
          textDocument: { uri: yamlUri },
          position: { line: 10, character: 11 },
        },
      });
      const completion = await rpc.response(2);
      expect(completion.result).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'YamlCreated' })]),
      );

      const changedYaml = yamlModule('RenamedCreated');
      rpc.send({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: yamlUri, version: 2 },
          contentChanges: [{ range: fullDocumentRange(initialYaml), text: changedYaml }],
        },
      });
      const changedDiagnostics = await rpc.notification('textDocument/publishDiagnostics');
      expect(diagnosticMessages(changedDiagnostics)).not.toContain(
        'Unknown scenario event "RenamedCreated"',
      );
      expect(diagnosticMessages(changedDiagnostics)).not.toContain(
        'Unknown scenario event "MissingEvent"',
      );
      await expectGenerated(root, 'RenamedCreated');
    } finally {
      rpc.close();
      server.kill();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

function jsonRpcClient(server: ChildProcessWithoutNullStreams): {
  send(message: Record<string, unknown>): void;
  response(id: number): Promise<JsonRpcMessage>;
  notification(method: string): Promise<JsonRpcMessage>;
  close(): void;
} {
  let buffer = Buffer.alloc(0);
  const messages: JsonRpcMessage[] = [];
  const waiters: {
    readonly match: (message: JsonRpcMessage) => boolean;
    readonly resolve: (message: JsonRpcMessage) => void;
  }[] = [];

  server.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const length = Number(/^Content-Length:\s*(\d+)$/im.exec(header)?.[1]);
      if (!Number.isFinite(length)) throw new Error(`Invalid language-server header: ${header}`);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const message = JSON.parse(
        buffer.subarray(bodyStart, bodyStart + length).toString('utf8'),
      ) as JsonRpcMessage;
      buffer = buffer.subarray(bodyStart + length);
      const waiterIndex = waiters.findIndex((waiter) => waiter.match(message));
      if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0]!.resolve(message);
      else messages.push(message);
    }
  });

  const next = (match: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> => {
    const queuedIndex = messages.findIndex(match);
    if (queuedIndex >= 0) return Promise.resolve(messages.splice(queuedIndex, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for language-server message'));
      }, 5_000);
      waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };

  return {
    send(message) {
      const body = JSON.stringify(message);
      server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    },
    response: (id) => next((message) => message.id === id),
    notification: (method) => next((message) => message.method === method),
    close() {
      server.stdin.end();
    },
  };
}

function diagnosticMessages(message: JsonRpcMessage): readonly string[] {
  const diagnostics = message.params?.diagnostics;
  return Array.isArray(diagnostics)
    ? diagnostics.flatMap((diagnostic) =>
        diagnostic !== null &&
        typeof diagnostic === 'object' &&
        'message' in diagnostic &&
        typeof diagnostic.message === 'string'
          ? [diagnostic.message]
          : [],
      )
    : [];
}

async function expectGenerated(root: string, eventType: string): Promise<void> {
  const generated = path.join(root, '.potemkin');
  await waitFor(async () => {
    const schema = await fs.readFile(path.join(generated, 'potemkin.schema.json'), 'utf8');
    const sdk = await fs.readFile(path.join(generated, 'potemkin-sdk.d.ts'), 'utf8');
    return schema.includes(eventType) && sdk.includes(eventType);
  });
}

async function writeProject(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, 'openapi.yaml'),
    [
      'openapi: 3.0.3',
      'info: { title: Language server protocol, version: "1.0.0" }',
      'paths:',
      '  /agents:',
      '    post:',
      '      operationId: createAgent',
      '      responses:',
      '        "201": { description: Created }',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'potemkin.yml'),
    [
      'version: 1',
      'specmatic: specmatic.yaml',
      'modules: [agent.yaml]',
      'openapi: [openapi.yaml]',
    ].join('\n'),
    'utf8',
  );
}

function yamlModule(eventType: string): string {
  return [
    'boundary: Agent',
    'contract_path: /agents',
    'event_catalog:',
    `  - type: ${eventType}`,
    '    payload_template: { id: "$uuidv7()" }',
    'behaviors:',
    '  - name: create',
    '    match:',
    '      operationId: createAgent',
    '      condition: "true"',
    `    emit: ${eventType}`,
    'reducers: []',
  ].join('\n');
}

function fullDocumentRange(text: string): {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
} {
  const lines = text.split('\n');
  return {
    start: { line: 0, character: 0 },
    end: { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for generated language-server artifacts');
}
