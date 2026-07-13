import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// We'll test the new event cards in isolation by rendering ActivityFeed
// with mocked data. Read ActivityFeed.tsx first to understand how it
// imports fetchActivity — mock that function.

vi.mock('../lib/api', () => ({
  fetchActivity: vi.fn().mockResolvedValue([
    {
      id: 'evt_1',
      createdAt: '2026-07-10T12:00:00Z',
      appName: 'My App',
      eventType: 'listing_update_alert',
      payload: {
        monitorId: 'lm_1',
        listingUpdateId: 'lu_1',
        baseline: { impressions: 1000, downloads: 200, conversionRate: 0.2 },
        current: { impressions: 800, downloads: 160, conversionRate: 0.16 },
        deltas: { conversionRateDelta: -0.2, impressionsDelta: -0.2, downloadsDelta: -0.2 },
      },
    },
  ]),
  revertListingUpdate: vi.fn().mockResolvedValue({ ok: true }),
  dismissListingAlert: vi.fn().mockResolvedValue({ ok: true }),
}));

// Import ActivityFeed after mocking
describe('ActivityFeed — stop-loss cards', () => {
  it('renders listing_update_alert card with metric drops', async () => {
    const { ActivityFeed } = await import('./ActivityFeed');
    render(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByText(/conversion rate/i)).toBeTruthy();
    });
  });

  it('shows Revert Listing and Dismiss buttons on alert card', async () => {
    const { ActivityFeed } = await import('./ActivityFeed');
    render(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /revert listing/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy();
    });
  });

  it('calls revertListingUpdate when Revert button is clicked', async () => {
    const { revertListingUpdate } = await import('../lib/api');
    const { ActivityFeed } = await import('./ActivityFeed');
    render(<ActivityFeed />);
    await waitFor(() => screen.getByRole('button', { name: /revert listing/i }));
    fireEvent.click(screen.getByRole('button', { name: /revert listing/i }));
    await waitFor(() => {
      expect(revertListingUpdate).toHaveBeenCalledWith('lm_1');
    });
  });
});
