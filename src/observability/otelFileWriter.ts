import { Worker } from 'node:worker_threads';
import { writeFile } from 'node:fs/promises';

const WORKER_SOURCE = String.raw`
  const { appendFile } = require('node:fs/promises');
  const { parentPort, workerData } = require('node:worker_threads');

  if (parentPort === null) throw new Error('OTEL file writer worker has no parent port');
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', (message) => {
    if (message.type === 'shutdown') {
      process.exitCode = 0;
      return;
    }
    if (message.type !== 'append') return;
    appendFile(workerData.filePath, message.data, 'utf8')
      .then(() => parentPort.postMessage({ type: 'ack', id: message.id }))
      .catch((error) =>
        parentPort.postMessage({
          type: 'write-error',
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  });
`;

export interface OtlpFileWriterOptions<T> {
  readonly filePath: string;
  readonly capacity?: number;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly serialize?: (value: T) => string;
  readonly onDrop?: (count: number) => void;
  readonly onError?: (error: Error) => void;
  readonly onRestart?: (count: number) => void;
}

interface AppendMessage {
  readonly type: 'append';
  readonly id: number;
  readonly data: string;
}

interface WorkerReadyMessage {
  readonly type: 'ready';
}

interface WorkerAckMessage {
  readonly type: 'ack';
  readonly id: number;
}

interface WorkerWriteErrorMessage {
  readonly type: 'write-error';
  readonly id: number;
  readonly error: string;
}

type WorkerMessage = WorkerReadyMessage | WorkerAckMessage | WorkerWriteErrorMessage;

interface InFlightBatch {
  readonly id: number;
  readonly lines: readonly string[];
}

type Waiter = () => void;

/**
 * Asynchronous append-only persistence for OTEL observations.
 *
 * The request/collector callback only serializes and enqueues a line. File
 * I/O happens in a worker and each worker message contains a complete batch,
 * so the producer never waits for an individual append operation.
 */
export class OtlpFileWriter<T> {
  private readonly filePath: string;
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly serialize: (value: T) => string;
  private readonly onDrop?: (count: number) => void;
  private readonly onError?: (error: Error) => void;
  private readonly onRestart?: (count: number) => void;
  private readonly ring: Array<string | undefined>;
  private head = 0;
  private tail = 0;
  private size = 0;
  private worker: Worker | undefined;
  private workerReady = false;
  private inFlight: InFlightBatch | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private nextBatchId = 1;
  private _droppedCount = 0;
  private _restartCount = 0;
  private _batchCount = 0;
  private closing = false;
  private closed = false;
  private readonly drainWaiters: Waiter[] = [];

  public constructor(options: OtlpFileWriterOptions<T>) {
    this.filePath = options.filePath;
    this.capacity = Math.max(1, options.capacity ?? 4_096);
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 64, this.capacity));
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? 10);
    this.serialize = options.serialize ?? ((value) => JSON.stringify(value));
    this.onDrop = options.onDrop;
    this.onError = options.onError;
    this.onRestart = options.onRestart;
    this.ring = Array.from({ length: this.capacity }, () => undefined);
    this.startWorker(false);
  }

  public get droppedCount(): number {
    return this._droppedCount;
  }

  public get restartCount(): number {
    return this._restartCount;
  }

  public get batchCount(): number {
    return this._batchCount;
  }

  public get pendingCount(): number {
    return this.size + (this.inFlight?.lines.length ?? 0);
  }

  public enqueue(value: T): boolean {
    if (this.closed || this.closing || this.pendingCount >= this.capacity) {
      this._droppedCount += 1;
      this.onDrop?.(1);
      return false;
    }
    let line: string;
    try {
      line = this.serialize(value);
    } catch (error) {
      this.reportError(error);
      this._droppedCount += 1;
      this.onDrop?.(1);
      return false;
    }
    if (!line.endsWith('\n')) line += '\n';
    this.ring[this.tail] = line;
    this.tail = (this.tail + 1) % this.capacity;
    this.size += 1;
    this.scheduleFlush();
    return true;
  }

  public async close(timeoutMs = 10_000): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (this.size === 0 && this.inFlight === undefined) {
      await this.stopWorker();
      this.closed = true;
      return;
    }
    this.scheduleFlush();
    await this.waitForDrain(timeoutMs);
    await this.stopWorker();
    this.closed = true;
  }

  /** Drain pending exports and clear the append-only stream at a lifecycle boundary. */
  public async reset(timeoutMs = 10_000): Promise<void> {
    if (this.closed) {
      await writeFile(this.filePath, '', 'utf8');
      return;
    }
    await this.waitForDrain(timeoutMs);
    await writeFile(this.filePath, '', 'utf8');
  }

  private startWorker(isRestart: boolean): void {
    if (this.closed || this.worker !== undefined) return;
    if (isRestart) {
      this._restartCount += 1;
      this.onRestart?.(this._restartCount);
    }
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { filePath: this.filePath },
    });
    this.worker = worker;
    this.workerReady = false;
    worker.on('message', (message: WorkerMessage) => this.handleWorkerMessage(worker, message));
    worker.on('error', (error: Error) => this.handleWorkerFailure(worker, error));
    worker.on('exit', (code) => {
      if (this.worker !== worker || this.closed) return;
      this.handleWorkerFailure(
        worker,
        new Error(`OTEL file writer worker exited with code ${code}`),
      );
    });
  }

  private handleWorkerMessage(worker: Worker, message: WorkerMessage): void {
    if (this.worker !== worker) return;
    if (message.type === 'ready') {
      this.workerReady = true;
      this.pump();
      return;
    }
    if (message.type === 'ack') {
      if (this.inFlight?.id === message.id) this.inFlight = undefined;
      this.pump();
      this.notifyDrainIfIdle();
      return;
    }
    this.handleWorkerFailure(worker, new Error(message.error));
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker || this.closed) return;
    this.worker = undefined;
    this.workerReady = false;
    if (this.inFlight !== undefined) {
      this.requeueFront(this.inFlight.lines);
      this.inFlight = undefined;
    }
    this.reportError(error);
    void worker.terminate();
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer !== undefined) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.startWorker(true);
      this.pump();
    }, 25);
    this.restartTimer.unref?.();
  }

  private scheduleFlush(): void {
    if (!this.workerReady || this.inFlight !== undefined || this.size === 0) return;
    if (this.size >= this.batchSize || this.flushIntervalMs === 0) {
      this.pump();
      return;
    }
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.pump();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private pump(): void {
    if (
      !this.workerReady ||
      this.worker === undefined ||
      this.inFlight !== undefined ||
      this.size === 0
    )
      return;
    const lines = this.dequeueBatch();
    const id = this.nextBatchId++;
    this.inFlight = { id, lines };
    this._batchCount += 1;
    const message: AppendMessage = { type: 'append', id, data: lines.join('') };
    this.worker.postMessage(message);
  }

  private dequeueBatch(): string[] {
    const lines: string[] = [];
    const count = Math.min(this.batchSize, this.size);
    for (let index = 0; index < count; index += 1) {
      const line = this.ring[this.head];
      this.ring[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.size -= 1;
      if (line !== undefined) lines.push(line);
    }
    return lines;
  }

  private requeueFront(lines: readonly string[]): void {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (this.size >= this.capacity) {
        this._droppedCount += 1;
        this.onDrop?.(1);
        continue;
      }
      this.head = (this.head - 1 + this.capacity) % this.capacity;
      this.ring[this.head] = lines[index];
      this.size += 1;
    }
  }

  private async stopWorker(): Promise<void> {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    this.flushTimer = undefined;
    this.restartTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    this.workerReady = false;
    if (worker === undefined) return;
    worker.postMessage({ type: 'shutdown' });
    await worker.terminate();
  }

  private waitForDrain(timeoutMs: number): Promise<void> {
    if (this.size === 0 && this.inFlight === undefined) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const index = this.drainWaiters.indexOf(finish);
        if (index >= 0) this.drainWaiters.splice(index, 1);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.drainWaiters.push(finish);
    });
  }

  private notifyDrainIfIdle(): void {
    if (this.size !== 0 || this.inFlight !== undefined) return;
    for (const waiter of this.drainWaiters.slice()) waiter();
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.onError?.(normalized);
  }
}
