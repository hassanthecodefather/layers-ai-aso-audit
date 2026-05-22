import type { DimensionId } from '../domain/audit';

/**
 * The audit rubric — *as data*.
 *
 * The task says the framework may be refined, and a reviewer should be able
 * to retune it without touching scoring logic. So weights, labels, character
 * limits and the human-readable checks all live here, in one table. The
 * scoring engine, the agent prompt and the score card all read from it.
 *
 * Note on the total: the task's weight column sums to **110**, not 100. Rather
 * than silently drop a dimension, we keep all ten and *normalise* — the
 * overall score is `Σ(score·weight) / Σ(weight)`, which is a true 0-100
 * regardless of what the weights sum to. See `aggregate.ts`.
 */
export interface RubricDimension {
  readonly id: DimensionId;
  readonly label: string;
  /** Relative weight from the task brief (the column that sums to 110). */
  readonly weight: number;
  /** Apple's hard character limit, where the dimension has one. */
  readonly charLimit?: number;
  /** The concrete checks, lifted from the task's audit framework. */
  readonly checks: readonly string[];
}

export const RUBRIC: readonly RubricDimension[] = [
  {
    id: 'title',
    label: 'Title',
    weight: 20,
    charLimit: 30,
    checks: [
      'Primary keyword present',
      'Character utilisation close to the 30-char limit',
      'Brand vs. keyword balance',
      'Reads naturally — not keyword-stuffed',
    ],
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    weight: 15,
    charLimit: 30,
    checks: [
      'Distinct secondary keywords, not repeating the title',
      'Benefit-driven',
      'Full character utilisation',
    ],
  },
  {
    id: 'keywordField',
    label: 'Keyword Field',
    weight: 15,
    charLimit: 100,
    checks: [
      'No duplicates with title/subtitle',
      'Singular forms (Apple indexes both)',
      'No spaces after commas',
      'No wasted words ("app", category names, brand)',
      'Full 100 characters used',
    ],
  },
  {
    id: 'description',
    label: 'Description',
    weight: 10,
    checks: [
      'First 3 lines hook above the "more" cutoff',
      'Features framed as benefits',
      'Social proof present',
      'Clear call to action',
      'Natural keyword integration',
    ],
  },
  {
    id: 'screenshots',
    label: 'Screenshots',
    weight: 15,
    checks: [
      'All 10 slots used',
      'First 2-3 communicate core value',
      'Readable on-image text (Apple OCR-indexes it)',
      'Cohesive design language',
    ],
  },
  {
    id: 'previewVideo',
    label: 'App Preview Video',
    weight: 5,
    checks: [
      'A preview video exists',
      'Hook within the first 3 seconds',
      '15-30 seconds long',
      'Works without sound',
    ],
  },
  {
    id: 'ratings',
    label: 'Ratings & Reviews',
    weight: 15,
    checks: [
      'Healthy average rating',
      'Recent rating trend',
      'Themes in praise and complaints',
      'Developer responds to negative reviews',
    ],
  },
  {
    id: 'icon',
    label: 'Icon',
    weight: 5,
    checks: [
      'Distinctive in search results',
      'Clear at small sizes',
      'Category-appropriate',
      'Avoids unreadable text',
    ],
  },
  {
    id: 'conversion',
    label: 'Conversion Signals',
    weight: 5,
    checks: [
      'Promotional text in use',
      '"What\'s New" is informative',
      'In-App Events',
      'Custom product pages',
    ],
  },
  {
    id: 'competitive',
    label: 'Competitive Position',
    weight: 5,
    checks: [
      'Keyword coverage vs. top 3 category competitors',
      'Visual style vs. competitors',
      'Rating gap vs. competitors',
    ],
  },
] as const;

/** Sum of all rubric weights — 110 for the task's framework as given. */
export const TOTAL_WEIGHT = RUBRIC.reduce((sum, d) => sum + d.weight, 0);

const BY_ID = new Map(RUBRIC.map((d) => [d.id, d]));

/** Look up a dimension's rubric entry. Throws on an unknown id (a bug). */
export function rubricFor(id: DimensionId): RubricDimension {
  const dim = BY_ID.get(id);
  if (!dim) throw new Error(`Unknown rubric dimension: ${id}`);
  return dim;
}
