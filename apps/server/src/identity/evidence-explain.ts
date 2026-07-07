import type { ResolvedIdentity } from './resolve';
import type { SignalTallyEntry } from '../domain/identity';

/** One human-readable line of the "why we read the identity this way" rationale. */
export interface EvidenceLine {
  family: string;
  value: string;
  sourceTier: string;
  text: string;
}

/** Turn one agreeing tally entry into a plain-English sentence. */
function lineFor(entry: SignalTallyEntry): EvidenceLine {
  const base = { family: entry.family, value: entry.value, sourceTier: entry.sourceTier };
  switch (entry.family) {
    case 'developer':
      return { ...base, text: `Developer: "${entry.value}" — the app's maker.` };
    case 'bundle_id':
      return { ...base, text: `App ID org segment: "${entry.value}" — the reverse-domain owner.` };
    case 'marketing_domain':
      return { ...base, text: `Marketing site: ${entry.value} (fetched and cited).` };
    case 'reviews':
      return { ...base, text: `Reviews: ${entry.value}.` };
    case 'footprint':
      return { ...base, text: `Off-store footprint: ${entry.value}.` };
    default:
      return { ...base, text: `${entry.family}: ${entry.value}.` };
  }
}

/**
 * Explain, in plain English, why the resolver landed on `resolved.category`.
 * One line per signal family that actually voted (agrees=true), followed by the
 * conflicting store-category line when a declared genre is present. Renders only
 * what the tally recorded, so it degrades gracefully.
 */
export function explainIdentityEvidence(
  resolved: ResolvedIdentity,
  storeGenre: string | null,
): EvidenceLine[] {
  const lines = resolved.tally.filter((t) => t.agrees).map(lineFor);
  if (storeGenre) {
    lines.push({
      family: 'store_category',
      value: storeGenre,
      sourceTier: 'observed_on_store',
      text: `App Store category: "${storeGenre}" — the only signal pointing away from "${resolved.category}", and the conflict that made us ask.`,
    });
  }
  return lines;
}

/** The concrete consequences of confirming a category that contests the evidence. */
export function describeOverrideConsequences(
  chosenCategory: string,
  evidenceCategory: string,
): string[] {
  return [
    `Competitors will be discovered for "${chosenCategory}", not "${evidenceCategory}".`,
    `Keyword and copy recommendations will target "${chosenCategory}" terms.`,
    `The report will still flag "${evidenceCategory}" signals — we won't hide what the app is — so parts may read as mismatched. That's expected and labelled.`,
    `This choice sticks to every future audit until you re-open identity.`,
  ];
}
