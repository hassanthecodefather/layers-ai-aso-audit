import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetDueApps   = vi.fn();
const mockUpdateScanned = vi.fn().mockResolvedValue(undefined);
const mockRunScan      = vi.fn();

vi.mock('./store', () => ({
  getDueApps:        (...args: any[]) => mockGetDueApps(...args),
  updateLastScanned: (...args: any[]) => mockUpdateScanned(...args),
}));

vi.mock('./scan', () => ({
  runScan: (...args: any[]) => mockRunScan(...args),
}));

import { startTrackingScheduler } from './scheduler';

describe('startTrackingScheduler', () => {
  const fakeSql = {} as any;
  const fakeMastra = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires an immediate first pass on start', async () => {
    mockGetDueApps.mockResolvedValueOnce([]);
    const handle = startTrackingScheduler(fakeMastra, fakeSql);
    // Flush the immediate tick - just wait for microtasks
    await Promise.resolve();
    expect(mockGetDueApps).toHaveBeenCalled();
    handle.stop();
  });

  it('scans due apps and updates last_scanned_at', async () => {
    const dueApp = { tenantId: 'T1', app: { appId: 'A1', country: 'us', appName: 'App', url: 'https://x', bundleId: '', enabled: true, enabledAt: '', lastScannedAt: null } };
    mockGetDueApps.mockResolvedValueOnce([dueApp]).mockResolvedValue([]);
    mockRunScan.mockResolvedValueOnce(undefined);

    const handle = startTrackingScheduler(fakeMastra, fakeSql);
    // Run only pending timers to flush the initial tick
    await vi.runOnlyPendingTimersAsync();
    // Now check the calls
    expect(mockRunScan).toHaveBeenCalledWith(dueApp.app, 'T1', fakeSql, fakeMastra);
    expect(mockUpdateScanned).toHaveBeenCalledWith(fakeSql, 'T1', 'A1', 'us');
    handle.stop();
  });

  it('updateLastScanned is called even when runScan throws', async () => {
    const dueApp = { tenantId: 'T2', app: { appId: 'A2', country: 'us', appName: 'App', url: 'https://y', bundleId: '', enabled: true, enabledAt: '', lastScannedAt: null } };
    mockGetDueApps.mockResolvedValueOnce([dueApp]).mockResolvedValue([]);
    mockRunScan.mockRejectedValueOnce(new Error('scan failed'));

    const handle = startTrackingScheduler(fakeMastra, fakeSql);
    await vi.runOnlyPendingTimersAsync();

    expect(mockUpdateScanned).toHaveBeenCalledWith(fakeSql, 'T2', 'A2', 'us');
    handle.stop();
  });

  it('a scan error does not prevent other apps from being scanned', async () => {
    const due = [
      { tenantId: 'T3', app: { appId: 'FAIL', country: 'us', appName: 'Fail', url: 'https://f', bundleId: '', enabled: true, enabledAt: '', lastScannedAt: null } },
      { tenantId: 'T3', app: { appId: 'OK', country: 'us', appName: 'Ok', url: 'https://ok', bundleId: '', enabled: true, enabledAt: '', lastScannedAt: null } },
    ];
    mockGetDueApps.mockResolvedValueOnce(due).mockResolvedValue([]);
    mockRunScan
      .mockRejectedValueOnce(new Error('first fails'))
      .mockResolvedValueOnce(undefined);

    const handle = startTrackingScheduler(fakeMastra, fakeSql);
    await vi.runOnlyPendingTimersAsync();

    expect(mockRunScan).toHaveBeenCalledTimes(2);
    expect(mockUpdateScanned).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('stop() cancels the interval', async () => {
    mockGetDueApps.mockResolvedValue([]);
    const handle = startTrackingScheduler(fakeMastra, fakeSql);

    // Run the immediate first pass
    await vi.runOnlyPendingTimersAsync();

    // Count how many times getDueApps was called after the first pass
    const callsAfterFirstPass = mockGetDueApps.mock.calls.length;

    // Now stop the interval
    handle.stop();

    // Advance time by 3 hours - no new ticks should execute because interval is stopped
    vi.advanceTimersByTime(60 * 60 * 1000 * 3);
    await vi.runOnlyPendingTimersAsync();

    // Should still have same number of calls
    expect(mockGetDueApps.mock.calls.length).toBe(callsAfterFirstPass);
  });
});
