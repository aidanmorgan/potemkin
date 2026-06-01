/**
 * Unit tests for src/lifecycle/gracefulShutdown.ts
 *
 * Strategy: intercept createTerminus so we can extract and call the onShutdown
 * handler directly without spinning up a real http.Server or process signals.
 *
 * Scenarios:
 *  - afterDrain is called during onShutdown (after the drain-complete log)
 *  - afterDrain is called when no logger is configured
 *  - afterDrain that returns a Promise is awaited before onShutdown resolves
 *  - afterDrain that throws does not propagate the error out of onShutdown
 *  - afterDrain that rejects does not propagate the error out of onShutdown
 *  - onShutdown still logs 'engine drained' when afterDrain is absent
 *  - onShutdown still works when afterDrain is absent (no regression)
 */

import type { Server } from 'http';

// ---------------------------------------------------------------------------
// Mock @godaddy/terminus so we can capture the onShutdown handler
// ---------------------------------------------------------------------------

type TerminusOptions = {
  onShutdown?: () => void | Promise<void>;
  [key: string]: unknown;
};

let capturedOnShutdown: (() => void | Promise<void>) | undefined;

jest.mock('@godaddy/terminus', () => ({
  createTerminus: jest.fn((_server: unknown, opts: TerminusOptions) => {
    capturedOnShutdown = opts['onShutdown'];
  }),
}));

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(),
};

jest.mock('../../../src/observability/logger.js', () => ({
  childLogger: jest.fn(() => mockLog),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are set up
// ---------------------------------------------------------------------------

import { installGracefulShutdown } from '../../../src/lifecycle/gracefulShutdown.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeServer(): Server {
  return {} as Server;
}

function resetMocks(): void {
  capturedOnShutdown = undefined;
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installGracefulShutdown — onShutdown without afterDrain', () => {
  beforeEach(resetMocks);

  it('logs engine-drained message', async () => {
    installGracefulShutdown({ server: fakeServer(), logger: mockLog as never });

    expect(capturedOnShutdown).toBeDefined();
    await capturedOnShutdown!();

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining('engine drained'),
    );
  });

  it('resolves without error when afterDrain is absent', async () => {
    installGracefulShutdown({ server: fakeServer(), logger: mockLog as never });

    await expect(capturedOnShutdown!()).resolves.toBeUndefined();
  });
});

describe('installGracefulShutdown — onShutdown with afterDrain', () => {
  beforeEach(resetMocks);

  it('invokes afterDrain during shutdown', async () => {
    const afterDrain = jest.fn().mockResolvedValue(undefined);

    installGracefulShutdown({
      server: fakeServer(),
      logger: mockLog as never,
      afterDrain,
    });

    await capturedOnShutdown!();

    expect(afterDrain).toHaveBeenCalledTimes(1);
  });

  it('awaits an async afterDrain before resolving', async () => {
    const order: string[] = [];

    const afterDrain = jest.fn().mockImplementation(async () => {
      order.push('afterDrain-start');
      await Promise.resolve();
      order.push('afterDrain-end');
    });

    installGracefulShutdown({
      server: fakeServer(),
      logger: mockLog as never,
      afterDrain,
    });

    await capturedOnShutdown!();

    expect(order).toEqual(['afterDrain-start', 'afterDrain-end']);
  });

  it('calls afterDrain after the engine-drained log', async () => {
    const order: string[] = [];

    mockLog.info.mockImplementation(() => {
      order.push('log');
    });

    const afterDrain = jest.fn().mockImplementation(() => {
      order.push('afterDrain');
    });

    installGracefulShutdown({
      server: fakeServer(),
      logger: mockLog as never,
      afterDrain,
    });

    await capturedOnShutdown!();

    expect(order).toEqual(['log', 'afterDrain']);
  });

  it('does not propagate a synchronous throw from afterDrain', async () => {
    const afterDrain = jest.fn().mockImplementation(() => {
      throw new Error('cleanup exploded');
    });

    installGracefulShutdown({
      server: fakeServer(),
      logger: mockLog as never,
      afterDrain,
    });

    await expect(capturedOnShutdown!()).resolves.toBeUndefined();
  });

  it('does not propagate a rejected promise from afterDrain', async () => {
    const afterDrain = jest.fn().mockRejectedValue(new Error('async cleanup failed'));

    installGracefulShutdown({
      server: fakeServer(),
      logger: mockLog as never,
      afterDrain,
    });

    await expect(capturedOnShutdown!()).resolves.toBeUndefined();
  });

  it('logs a warning when afterDrain throws', async () => {
    const boom = new Error('cleanup exploded');
    const afterDrain = jest.fn().mockImplementation(() => {
      throw boom;
    });

    installGracefulShutdown({
      server: fakeServer(),
      logger: mockLog as never,
      afterDrain,
    });

    await capturedOnShutdown!();

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom }),
      expect.stringContaining('afterDrain'),
    );
  });

  it('logs a warning when afterDrain rejects', async () => {
    const boom = new Error('async cleanup failed');
    const afterDrain = jest.fn().mockRejectedValue(boom);

    installGracefulShutdown({
      server: fakeServer(),
      logger: mockLog as never,
      afterDrain,
    });

    await capturedOnShutdown!();

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom }),
      expect.stringContaining('afterDrain'),
    );
  });

  it('works without a logger (no crash when afterDrain throws)', async () => {
    const afterDrain = jest.fn().mockRejectedValue(new Error('no logger'));

    installGracefulShutdown({
      server: fakeServer(),
      afterDrain,
    });

    await expect(capturedOnShutdown!()).resolves.toBeUndefined();
  });
});
