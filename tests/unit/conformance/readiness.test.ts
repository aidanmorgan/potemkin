import {
  ReadinessAbortedError,
  waitForReadiness,
  type ReadinessProbeResult,
} from '../../../src/conformance/specmaticProcess';

describe('readiness polling', () => {
  it('retries until ready and retains the latest diagnostic', async () => {
    let now = 0;
    const sleep = jest.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const timeoutSignal = jest.fn(() => new AbortController().signal);
    const probe = jest
      .fn<Promise<ReadinessProbeResult>, [AbortSignal]>()
      .mockResolvedValueOnce({ ready: false, diagnostic: 'HTTP 503' })
      .mockResolvedValueOnce({ ready: false, diagnostic: 'ready=false {"routes":0}' })
      .mockResolvedValueOnce({ ready: true });

    await waitForReadiness({
      description: 'test service',
      timeoutMs: 1_000,
      attemptTimeoutMs: 250,
      intervalMs: 100,
      probe,
      now: () => now,
      sleep,
      timeoutSignal,
    });

    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(timeoutSignal).toHaveBeenNthCalledWith(1, 250);
    expect(timeoutSignal).toHaveBeenNthCalledWith(2, 250);
  });

  it('enforces the overall timeout and reports the latest failure', async () => {
    let now = 0;
    const sleep = async (milliseconds: number): Promise<void> => {
      now += milliseconds;
    };
    const probe = jest.fn<Promise<ReadinessProbeResult>, [AbortSignal]>().mockResolvedValue({
      ready: false,
      diagnostic: 'ECONNREFUSED',
    });

    await expect(
      waitForReadiness({
        description: 'test service',
        timeoutMs: 250,
        attemptTimeoutMs: 100,
        intervalMs: 100,
        probe,
        now: () => now,
        sleep,
        timeoutSignal: () => new AbortController().signal,
      }),
    ).rejects.toThrow('test service did not become ready within 250 ms (last: ECONNREFUSED)');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('does not retry a fatal readiness failure', async () => {
    const sleep = jest.fn(async () => undefined);
    const failure = new ReadinessAbortedError('child exited with code 1');
    const probe = jest
      .fn<Promise<ReadinessProbeResult>, [AbortSignal]>()
      .mockRejectedValue(failure);

    await expect(
      waitForReadiness({
        description: 'test service',
        timeoutMs: 30_000,
        attemptTimeoutMs: 1_000,
        intervalMs: 100,
        probe,
        sleep,
        timeoutSignal: () => new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('propagates caller cancellation without converting it into a timeout', async () => {
    const controller = new AbortController();
    const reason = new Error('startup cancelled');
    controller.abort(reason);
    const probe = jest.fn<Promise<ReadinessProbeResult>, [AbortSignal]>();

    await expect(
      waitForReadiness({
        description: 'test service',
        timeoutMs: 30_000,
        attemptTimeoutMs: 1_000,
        intervalMs: 100,
        probe,
        signal: controller.signal,
        timeoutSignal: () => new AbortController().signal,
      }),
    ).rejects.toBe(reason);
    expect(probe).not.toHaveBeenCalled();
  });
});
