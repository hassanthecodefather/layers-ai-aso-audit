/**
 * F · Storefront sweep.
 *
 * For a given app, fetches the iTunes listing for each target storefront (country)
 * and compares it to the primary (US) listing to detect localisation gaps.
 *
 * Design decisions:
 *  - Purely structural — no LLM, no paid data sources; "Free iTunes only" (plan §F).
 *  - Observe-only — results are never written to the ledger.
 *  - Sequential — one network call per country, respects the pacer.
 *  - Inherits the primary identity — each sub-run already knows what the app does.
 *
 * A "gap" is any field that is identical between the primary (US) listing and
 * the foreign storefront — same text means the content was NOT translated.
 * Missing app (not available in that country) is also surfaced as a gap.
 */

import { fetchITunesCore, type ITunesCore } from './itunes';
import type { ProofRegime } from '../domain/recommendation';

// ── Public types ──────────────────────────────────────────────────────────────

export interface StorefrontGap {
  field: 'title' | 'subtitle' | 'description' | 'availability';
  us: string | null;
  storefront: string | null;
  /** True when the field value is byte-identical between US and target. */
  identical: boolean;
}

export interface StorefrontRec {
  country: string;
  field: StorefrontGap['field'];
  title: string;
  rationale: string;
  proofRegime: ProofRegime;
}

export interface StorefrontResult {
  country: string;
  available: boolean;
  listing: ITunesCore | null;
  gaps: StorefrontGap[];
  recs: StorefrontRec[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const COUNTRY_NAMES: Record<string, string> = {
  gb: 'United Kingdom',
  de: 'Germany',
  fr: 'France',
  es: 'Spain',
  it: 'Italy',
  au: 'Australia',
  ca: 'Canada',
  jp: 'Japan',
  kr: 'South Korea',
  br: 'Brazil',
  mx: 'Mexico',
  nl: 'Netherlands',
  se: 'Sweden',
  no: 'Norway',
  dk: 'Denmark',
  fi: 'Finland',
  pl: 'Poland',
  pt: 'Portugal',
  ru: 'Russia',
  tr: 'Turkey',
  in: 'India',
  cn: 'China',
  hk: 'Hong Kong',
  sg: 'Singapore',
  tw: 'Taiwan',
  nz: 'New Zealand',
  za: 'South Africa',
  ar: 'Argentina',
  cl: 'Chile',
  co: 'Colombia',
};

function countryName(code: string): string {
  return COUNTRY_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}

function isMeaningfullyDifferent(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  return a.trim() !== b.trim();
}

function buildGaps(primary: ITunesCore, storefront: ITunesCore): StorefrontGap[] {
  const gaps: StorefrontGap[] = [];

  // Title: always extracted from iTunes name field
  const titleIdentical = primary.name.trim() === storefront.name.trim();
  if (titleIdentical) {
    gaps.push({ field: 'title', us: primary.name, storefront: storefront.name, identical: true });
  }

  // Description
  const descIdentical =
    primary.description.trim() !== '' &&
    primary.description.trim() === storefront.description.trim();
  if (descIdentical) {
    gaps.push({
      field: 'description',
      us: primary.description.slice(0, 120) + '…',
      storefront: storefront.description.slice(0, 120) + '…',
      identical: true,
    });
  }

  // Release notes double as a subtitle proxy (iTunes Lookup doesn't expose subtitle directly).
  // Only flag when we have notes in the primary and the foreign storefront's notes are identical.
  if (
    primary.releaseNotes &&
    storefront.releaseNotes &&
    primary.releaseNotes.trim() === storefront.releaseNotes.trim()
  ) {
    gaps.push({
      field: 'subtitle',
      us: primary.releaseNotes,
      storefront: storefront.releaseNotes,
      identical: true,
    });
  }

  void isMeaningfullyDifferent; // referenced for future diffing
  return gaps;
}

function gapToRec(gap: StorefrontGap, country: string): StorefrontRec {
  const region = countryName(country);
  switch (gap.field) {
    case 'title':
      return {
        country,
        field: 'title',
        title: `Localise title for the ${region} storefront`,
        rationale:
          `The title in ${region} is byte-identical to the US listing. ` +
          'Translate or adapt the title for local search keywords — iTunes country storefronts use independent keyword indexes.',
        proofRegime: 'observable_now',
      };
    case 'description':
      return {
        country,
        field: 'description',
        title: `Translate description for ${region}`,
        rationale:
          `The description in ${region} is identical to the US version. ` +
          'A localised description increases conversion for non-English speakers and can include region-specific social proof.',
        proofRegime: 'correlational',
      };
    case 'subtitle':
      return {
        country,
        field: 'subtitle',
        title: `Localise subtitle / release notes for ${region}`,
        rationale:
          `The release notes in ${region} are identical to the US listing. ` +
          'Consider adding region-specific context or translating the content.',
        proofRegime: 'correlational',
      };
    case 'availability':
      return {
        country,
        field: 'availability',
        title: `App not available in ${region}`,
        rationale:
          `The app has no listing in the ${region} App Store. ` +
          'Expanding distribution to this storefront is a growth opportunity if the market is relevant.',
        proofRegime: 'observable_now',
      };
  }
}

// ── Public surface ────────────────────────────────────────────────────────────

/**
 * Default storefront targets — the four largest non-US English-adjacent stores
 * plus Japan and Germany as the two biggest non-English markets.
 */
export const DEFAULT_SWEEP_COUNTRIES = ['gb', 'au', 'ca', 'de'] as const;

/**
 * Sweep the given storefronts and compare each to the US (primary) listing.
 *
 * @param appId      The numeric iTunes app ID (no URL needed).
 * @param primary    The already-fetched US listing — avoids a duplicate fetch.
 * @param countries  ISO 3166-1 alpha-2 country codes to sweep (lowercase).
 */
export async function sweepStorefronts(
  appId: string,
  primary: ITunesCore,
  countries: readonly string[] = DEFAULT_SWEEP_COUNTRIES,
): Promise<StorefrontResult[]> {
  const results: StorefrontResult[] = [];

  for (const country of countries) {
    const result = await fetchITunesCore({ appId, country });
    if (!result.ok) {
      // App not available in this country (or transient error — treat as unavailable).
      results.push({
        country,
        available: false,
        listing: null,
        gaps: [{ field: 'availability', us: primary.name, storefront: null, identical: false }],
        recs: [gapToRec({ field: 'availability', us: primary.name, storefront: null, identical: false }, country)],
      });
      continue;
    }

    const storefront = result.value;
    const gaps = buildGaps(primary, storefront);
    results.push({
      country,
      available: true,
      listing: storefront,
      gaps,
      recs: gaps.map((g) => gapToRec(g, country)),
    });
  }

  return results;
}
