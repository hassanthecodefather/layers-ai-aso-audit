# ID-lite / P1 test fixtures

Frozen real responses captured 2026-06-24 (US storefront), used as the red-test
inputs for the §F acceptance criteria. Each app was chosen to exercise one
branch of the confidence ladder (spec §E) and the escalation gate (spec ID):

| Fixture | App | Why it's here (§F ID-lite) |
|---|---|---|
| `rivian` | Rivian (`1570215232`, `com.rivian.ios.consumer`, primaryGenre **Travel**) | Store category Travel vs function (bundle `rivian` + reviews about trucks/charging) = **cross-domain → escalate**. `rivian.competitors.search.json` shows the trap: a Travel search returns Booking.com/Expedia, never the real peer (Tesla). |
| `tiktok` | TikTok (`835599320`, Entertainment) | Strong, agreeing signals → **zero asks**. |
| `spotify` | Spotify (`324684580`, Music) | Strong, agreeing signals → **zero asks**. |
| `onstoreonly` | To-Do List widget (`1585508533`, vanity bundle `Amit.Verma.apps.*`, **no sellerUrl**) | Only on-store first-party signals, no marketing domain → band **capped at ≤ medium**. |

Files per fixture:
- `<name>.itunes.json` — raw iTunes Lookup response (carries `bundleId`,
  `sellerUrl`, genres — the day-one ID-lite signals).
- `<name>.reviews.json` — raw iTunes customer-reviews RSS (review-vocabulary
  signal family).
- `rivian.competitors.search.json` — raw iTunes Search for the category term,
  i.e. the category-derived (wrong) peer set.

These are inputs only — never mutated by tests. Refreshing them is a deliberate
act (Apple's live data drifts); the resolver logic must stay deterministic over
whatever snapshot is frozen here.
