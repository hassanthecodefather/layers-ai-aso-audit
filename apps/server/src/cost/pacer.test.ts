/**
 * Unit tests for src/cost/pacer.ts
 * Uses vi.useFakeTimers() so no real waiting occurs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SerialPacer, getPacer, setPacer } from './pacer';

const MIN_INTERVAL_MS = 3500;

beforeEach(() => {
  vi.useFakeTimers();
  // Pin jitter to zero so timing assertions are deterministic regardless of JITTER_MS.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  // Reset singleton to a fresh pacer before each test
  setPacer(new SerialPacer());
  getPacer().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SerialPacer', () => {
  it('first call does NOT sleep', async () => {
    const pacer = new SerialPacer();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const waitPromise = pacer.wait();
    await vi.runAllTimersAsync();
    await waitPromise;

    // setTimeout should NOT have been called with a non-zero delay for sleeping
    const sleepCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => (ms as number) > 0);
    expect(sleepCalls).toHaveLength(0);
    setTimeoutSpy.mockRestore();
  });

  it('second immediate call sleeps ~3500ms', async () => {
    const pacer = new SerialPacer();

    // First call — establishes lastCallMs
    const first = pacer.wait();
    await vi.runAllTimersAsync();
    await first;

    // Second call — should sleep MIN_INTERVAL_MS since no time has elapsed
    let resolved = false;
    const second = pacer.wait().then(() => { resolved = true; });

    // Before advancing timers the second call should still be pending
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    await second;

    expect(resolved).toBe(true);
  });

  it('does NOT sleep when called after ≥3500ms have elapsed', async () => {
    const pacer = new SerialPacer();

    // First call
    const first = pacer.wait();
    await vi.runAllTimersAsync();
    await first;

    // Advance real clock beyond MIN_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS + 100);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const second = pacer.wait();
    await vi.runAllTimersAsync();
    await second;

    const sleepCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => (ms as number) > 0);
    expect(sleepCalls).toHaveLength(0);
    setTimeoutSpy.mockRestore();
  });

  it('wait(retryAfterMs=10000) waits ~10000ms when retryAfterMs > MIN_INTERVAL_MS', async () => {
    const pacer = new SerialPacer();

    // First call — establishes lastCallMs
    const first = pacer.wait();
    await vi.runAllTimersAsync();
    await first;

    let resolved = false;
    const retryAfterMs = 10_000;
    const second = pacer.wait(retryAfterMs).then(() => { resolved = true; });

    // Should not resolve before the retryAfterMs delay
    await vi.advanceTimersByTimeAsync(retryAfterMs - 100);
    expect(resolved).toBe(false);

    // Should resolve after the full retryAfterMs delay
    await vi.advanceTimersByTimeAsync(200);
    await second;
    expect(resolved).toBe(true);
  });

  it('wait(retryAfterMs=1000) still waits ~3500ms because MIN_INTERVAL_MS is the floor', async () => {
    const pacer = new SerialPacer();

    // First call — establishes lastCallMs
    const first = pacer.wait();
    await vi.runAllTimersAsync();
    await first;

    let resolved = false;
    const second = pacer.wait(1000).then(() => { resolved = true; });

    // retryAfterMs=1000 < MIN_INTERVAL_MS=3500, so floor wins
    await vi.advanceTimersByTimeAsync(1500);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    await second;
    expect(resolved).toBe(true);
  });

  it('reset() causes the next wait() to act as first call (no sleep)', async () => {
    const pacer = new SerialPacer();

    // First call
    const first = pacer.wait();
    await vi.runAllTimersAsync();
    await first;

    // Reset the pacer
    pacer.reset();

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // Next call should behave as first call — no sleep
    const second = pacer.wait();
    await vi.runAllTimersAsync();
    await second;

    const sleepCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => (ms as number) > 0);
    expect(sleepCalls).toHaveLength(0);
    setTimeoutSpy.mockRestore();
  });
});
