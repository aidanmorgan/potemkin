import { EventEmitter } from 'node:events';

const mockSpawn = jest.fn();
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: mockSpawn,
}));

import { startSpecmatic } from '../../../src/conformance/specmaticProcess';

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderr: EventEmitter & { setEncoding: jest.Mock };
  unref: jest.Mock;
  kill: jest.Mock<boolean, [NodeJS.Signals]>;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  child.unref = jest.fn();
  child.kill = jest.fn<boolean, [NodeJS.Signals]>(() => true);
  return child;
}

describe('Specmatic process readiness and cleanup', () => {
  const nativeFetch = globalThis.fetch;

  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
  });

  it('coalesces concurrent readiness calls and accepts any HTTP response', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const cancel = jest.fn().mockResolvedValue(undefined);
    const fetch = jest.fn().mockResolvedValue({
      status: 400,
      body: { cancel },
    } as unknown as Response);
    globalThis.fetch = fetch;

    const handle = await startSpecmatic({
      contractPaths: ['/tmp/contract.yaml'],
      pluginJar: '/tmp/plugin.jar',
      specmaticJar: '/tmp/specmatic.jar',
      stubPort: 4321,
    });

    await Promise.all([handle.ready(), handle.ready()]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4321/', {
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('fails immediately with a process diagnostic when the JVM exits', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const fetch = jest.fn();
    globalThis.fetch = fetch;

    const handle = await startSpecmatic({
      contractPaths: ['/tmp/contract.yaml'],
      pluginJar: '/tmp/plugin.jar',
      specmaticJar: '/tmp/specmatic.jar',
      stubPort: 4322,
    });

    child.stderr.emit('data', 'invalid contract: missing paths\n');
    child.exitCode = 17;
    await expect(handle.ready()).rejects.toThrow('Specmatic process exited with code 17');
    await expect(handle.ready()).rejects.toThrow('invalid contract: missing paths');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('coalesces shutdown calls and resolves after the child closes', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const handle = await startSpecmatic({
      contractPaths: ['/tmp/contract.yaml'],
      pluginJar: '/tmp/plugin.jar',
      specmaticJar: '/tmp/specmatic.jar',
      stubPort: 4323,
    });

    const first = handle.shutdown();
    const second = handle.shutdown();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');

    await Promise.all([first, second]);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
