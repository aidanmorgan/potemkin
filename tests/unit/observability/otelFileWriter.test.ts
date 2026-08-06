import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OtlpFileWriter } from '../../../src/observability/otelFileWriter';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

describe('OtlpFileWriter', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'potemkin-otel-writer-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends ordered records in batches without rewriting the stream', async () => {
    const writer = new OtlpFileWriter<{ id: number }>({
      filePath: join(root, 'exports.ndjson'),
      batchSize: 3,
      flushIntervalMs: 0,
    });

    for (let id = 0; id < 7; id += 1) expect(writer.enqueue({ id })).toBe(true);
    await writer.close();

    const lines = (await readFile(join(root, 'exports.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number });
    expect(lines.map(({ id }) => id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(writer.batchCount).toBe(3);
    expect(writer.droppedCount).toBe(0);
  });

  it('bounds the ring buffer and reports dropped records', async () => {
    const dropped: number[] = [];
    const writer = new OtlpFileWriter<number>({
      filePath: join(root, 'exports.ndjson'),
      capacity: 2,
      batchSize: 2,
      flushIntervalMs: 10_000,
      onDrop: (count) => dropped.push(count),
    });

    expect(writer.enqueue(1)).toBe(true);
    expect(writer.enqueue(2)).toBe(true);
    expect(writer.enqueue(3)).toBe(false);
    expect(writer.droppedCount).toBe(1);
    expect(dropped).toEqual([1]);
    await writer.close();
  });

  it('restarts a crashed worker and drains the queued records in order', async () => {
    const writer = new OtlpFileWriter<{ id: number }>({
      filePath: join(root, 'exports.ndjson'),
      batchSize: 2,
      flushIntervalMs: 0,
    });
    const internals = writer as unknown as {
      worker?: { terminate(): Promise<number> };
      workerReady?: boolean;
    };
    await waitFor(() => internals.workerReady === true);
    await internals.worker?.terminate();
    expect(writer.enqueue({ id: 1 })).toBe(true);
    await waitFor(() => writer.restartCount >= 1);
    expect(writer.enqueue({ id: 2 })).toBe(true);
    await writer.close();

    const lines = (await readFile(join(root, 'exports.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number });
    expect(lines.map(({ id }) => id)).toEqual([1, 2]);
  });

  it('keeps producer enqueue latency bounded while the worker is busy', async () => {
    const writer = new OtlpFileWriter<number>({
      filePath: join(root, 'exports.ndjson'),
      capacity: 1_000,
      batchSize: 1,
      flushIntervalMs: 0,
    });
    const startedAt = performance.now();
    for (let value = 0; value < 1_000; value += 1) writer.enqueue(value);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(250);
    await writer.close();
  });
});
