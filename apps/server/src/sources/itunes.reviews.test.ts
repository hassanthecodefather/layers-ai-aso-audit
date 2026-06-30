/**
 * Unit tests for fetchReviews pagination and field mapping (Task D1).
 *
 * fetchJson → fetchWithRetry → global.fetch, so we stub global.fetch directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchReviews } from './itunes';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ref = { appId: '123456789', country: 'us' };

/** Build a minimal RSS entry with only the fields we want to test. */
function makeEntry(opts: {
  rating?: string;
  id?: string;
  version?: string;
  title?: string;
  author?: string;
  body?: string;
  updated?: string;
}) {
  return {
    'im:rating': { label: opts.rating ?? '5' },
    id: opts.id ? { label: opts.id } : undefined,
    'im:version': opts.version ? { label: opts.version } : undefined,
    title: { label: opts.title ?? 'Great app' },
    content: { label: opts.body ?? 'Really love it.' },
    author: { name: { label: opts.author ?? 'Tester' } },
    updated: { label: opts.updated ?? '2024-01-01T00:00:00-07:00' },
  };
}

/** Wrap entries in the iTunes RSS feed envelope. */
function feedResponse(entries: unknown[]) {
  return {
    feed: {
      entry: entries.length === 1 ? entries[0] : entries,
    },
  };
}

/** Build a Response stub from a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/** Empty-page response — causes the pagination loop to break. */
const emptyPage = () => jsonResponse({ feed: { entry: [] } });

describe('fetchReviews — field mapping', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses id and appVersion from RSS entries', async () => {
    const entry = makeEntry({ id: '12345', version: '2.1.0', rating: '4' });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(feedResponse([entry])))
      .mockImplementation(() => Promise.resolve(emptyPage())); // page 2+ → stop

    const reviews = await fetchReviews(ref, 500);

    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.id).toBe('12345');
    expect(reviews[0]!.appVersion).toBe('2.1.0');
    expect(reviews[0]!.rating).toBe(4);
  });

  it('maps author, title, body, and updated', async () => {
    const entry = makeEntry({
      author: 'Alice',
      title: 'Wonderful',
      body: 'Best app ever.',
      updated: '2024-06-01T12:00:00Z',
    });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(feedResponse([entry])))
      .mockImplementation(() => Promise.resolve(emptyPage()));

    const reviews = await fetchReviews(ref, 500);

    expect(reviews[0]!.author).toBe('Alice');
    expect(reviews[0]!.title).toBe('Wonderful');
    expect(reviews[0]!.body).toBe('Best app ever.');
    expect(reviews[0]!.updated).toBe('2024-06-01T12:00:00Z');
  });

  it('sets appVersion to null when im:version is absent', async () => {
    const entry = makeEntry({ version: undefined });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(feedResponse([entry])))
      .mockImplementation(() => Promise.resolve(emptyPage()));

    const reviews = await fetchReviews(ref, 500);

    expect(reviews[0]!.appVersion).toBeNull();
  });

  it('sets id to undefined when id.label is absent', async () => {
    const entry = makeEntry({ id: undefined });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(feedResponse([entry])))
      .mockImplementation(() => Promise.resolve(emptyPage()));

    const reviews = await fetchReviews(ref, 500);

    expect(reviews[0]!.id).toBeUndefined();
  });
});

describe('fetchReviews — pagination', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops paginating when a page returns empty entries', async () => {
    // page 1 returns 2 reviews, page 2 returns empty feed → stop
    const page1Entries = [makeEntry({ id: 'r1' }), makeEntry({ id: 'r2' })];
    const page2Body = { feed: { entry: [] } };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(feedResponse(page1Entries)))
      .mockResolvedValueOnce(jsonResponse(page2Body));

    const reviews = await fetchReviews(ref, 500);

    // Should have exactly the 2 reviews from page 1; page 2 caused early exit.
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.id).toBe('r1');
    expect(reviews[1]!.id).toBe('r2');

    // fetch called twice: once for page 1, once for page 2.
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
  });

  it('does not fetch further pages after an empty page', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ feed: { entry: [] } })); // page 1 empty

    const reviews = await fetchReviews(ref, 500);

    expect(reviews).toHaveLength(0);
    // Only 1 fetch call — broke immediately on empty page 1.
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it('respects the limit cap', async () => {
    // Each "page" returns 50 entries; with limit=75 we should get exactly 75.
    const makeEntries = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) =>
        makeEntry({ id: `${prefix}-${i}`, rating: '5' }),
      );

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(feedResponse(makeEntries(50, 'p1'))))
      .mockResolvedValueOnce(jsonResponse(feedResponse(makeEntries(50, 'p2'))))
      .mockResolvedValueOnce(jsonResponse(feedResponse(makeEntries(50, 'p3'))));

    const reviews = await fetchReviews(ref, 75);

    expect(reviews).toHaveLength(75);
  });

  it('collects reviews across multiple pages', async () => {
    const page1 = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];
    const page2 = [makeEntry({ id: 'c' })];

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(feedResponse(page1)))
      .mockResolvedValueOnce(jsonResponse(feedResponse(page2)))
      .mockResolvedValueOnce(jsonResponse({ feed: { entry: [] } })); // page 3 empty

    const reviews = await fetchReviews(ref, 500);

    expect(reviews).toHaveLength(3);
    expect(reviews.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('fetchReviews — error handling', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] on fetch error', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

    const reviews = await fetchReviews(ref, 500);

    expect(reviews).toEqual([]);
  });

  it('returns results collected so far when a later page errors', async () => {
    const page1 = [makeEntry({ id: 'ok' })];

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse(feedResponse(page1)))
      .mockRejectedValueOnce(new Error('Timeout on page 2'));

    const reviews = await fetchReviews(ref, 500);

    // Got the 1 review from page 1; page 2 error caused early exit.
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.id).toBe('ok');
  });
});
