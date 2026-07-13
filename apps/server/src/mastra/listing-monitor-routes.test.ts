import { describe, it, expect } from 'vitest';

// Routes are hard to unit-test without the full Hono context.
// Verify the module exports the expected route array.
describe('listing-monitor-routes', () => {
  it('exports listingMonitorRoutes as an array', async () => {
    const { listingMonitorRoutes } = await import('./listing-monitor-routes');
    expect(Array.isArray(listingMonitorRoutes)).toBe(true);
    expect(listingMonitorRoutes.length).toBe(2);
  });
});
