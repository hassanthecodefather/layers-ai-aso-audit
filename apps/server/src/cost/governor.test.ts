import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InProcessGovernor, getGovernor, setGovernor } from './governor';
import { PassthroughGateway, GovernorDenialError } from './gateway';
import { setCache, NoOpCache } from './cache';

describe('InProcessGovernor', () => {
  let governor: InProcessGovernor;

  beforeEach(() => {
    // Use NoOpCache so gateway.fetch() cache lookup always misses and governor preflight runs.
    setCache(new NoOpCache());
    governor = new InProcessGovernor();
    setGovernor(governor);
  });

  afterEach(() => {
    vi.useRealTimers();
    governor.reset();
  });

  it('preflight() returns ok on the first call', () => {
    const result = governor.preflight();
    expect(result.ok).toBe(true);
  });

  it('preflight() returns err("count_cap") after METERED_CALL_CEILING calls', () => {
    // Fill up to the ceiling
    for (let i = 0; i < 2000; i++) {
      const r = governor.preflight();
      expect(r.ok).toBe(true);
    }
    // The 2001st call should be denied
    const result = governor.preflight();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('count_cap');
    }
  });

  it('startRun() returns ok on the first call', () => {
    const result = governor.startRun();
    expect(result.ok).toBe(true);
  });

  it('startRun() returns err("reentrant") within 2s of a prior call', () => {
    vi.useFakeTimers();
    governor.startRun();
    // Advance only 500ms — still within the 2s window
    vi.advanceTimersByTime(500);
    const result = governor.startRun();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('reentrant');
    }
  });

  it('startRun() returns ok again after > 2s', () => {
    vi.useFakeTimers();
    governor.startRun();
    // Advance past the 2s window
    vi.advanceTimersByTime(2001);
    const result = governor.startRun();
    expect(result.ok).toBe(true);
  });

  it('preflight() returns err("wallclock_cap") when run exceeds 5 minutes', () => {
    vi.useFakeTimers();
    governor.startRun();
    // Advance just past the 5-minute wall-clock cap
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    const result = governor.preflight();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('wallclock_cap');
    }
  });

  it('reset() clears all state so subsequent preflight()/startRun() succeed', () => {
    vi.useFakeTimers();
    // Fill call log to ceiling
    for (let i = 0; i < 2000; i++) {
      governor.preflight();
    }
    // Start a run so wall-clock timer is armed
    governor.startRun();
    // Advance past wall-clock cap
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // Verify both caps are hit
    expect(governor.preflight().ok).toBe(false);

    // Reset clears everything
    governor.reset();
    expect(governor.preflight().ok).toBe(true);
    expect(governor.startRun().ok).toBe(true);
  });

  it('GovernorDenialError is thrown by gateway.fetch() when preflight fails', async () => {
    // Fill the call log to trigger count_cap on the next preflight
    for (let i = 0; i < 2000; i++) {
      governor.preflight();
    }

    const gateway = new PassthroughGateway();
    await expect(
      gateway.fetch('https://example.com', { kind: 'app', upstream: 'itunes' }),
    ).rejects.toThrow(GovernorDenialError);

    // Verify the error carries the expected denial reason
    await expect(
      gateway.fetch('https://example.com', { kind: 'app', upstream: 'itunes' }),
    ).rejects.toMatchObject({ denial: 'count_cap' });
  });
});

describe('getGovernor singleton', () => {
  afterEach(() => {
    // Restore a fresh governor to avoid polluting other tests
    setGovernor(new InProcessGovernor());
  });

  it('getGovernor() returns the same instance on successive calls', () => {
    const a = getGovernor();
    const b = getGovernor();
    expect(a).toBe(b);
  });

  it('setGovernor() replaces the singleton', () => {
    const custom = new InProcessGovernor();
    setGovernor(custom);
    expect(getGovernor()).toBe(custom);
  });
});
