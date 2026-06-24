**ASO Agent · Planning · v1.3.1**

# The ASO Agent — Phased Build Plan

The audit we have today is stateless — it runs, emits suggestions, and forgets. This plan turns it into a system that **remembers** what it told you, sees the listing more deeply, grounds advice in real data, and scales — deliberately, one wall at a time. We ground what the app actually is, then five phases prove the loop for a single user; the phases beyond scale it — 1K, 5K, 10K — and teach it to act on the store, all the way to the north star.

*v1.3.1 · the phased ASO build plan · paired editions — specification.html (for a human to read) + specification.md (for an LLM/agent to execute)*

---

## What's new in v1.3.1 — review-hardening

Successive review passes against the v1.2.0 Build Appendix, each fix kept in sync across both editions:

- **`rec_key` collision fixed** — added a `value_key` discriminator so two distinct same-intent recommendations can't silently collapse; normalization pinned (casefold + NFC + plural-collapse).
- **Tombstones made app-scoped** (survive identity-version bumps); **`aso_rec_occurrences`** added as the belief-accumulation write path (`recordOccurrence` on `StorageClient`).
- **Complaint-theme taxonomy enumerated** (15 buckets + `other`), with an embedding fallback (cosine ≥ 0.85); **feature requests declared disjoint** (human hand-off, never ledgered).
- **`taxonomy_version`** added and **defined** (hand-bumped `theme-taxonomy@N`), with a bucket-split→`superseded` migration rule.
- **Governor recomputed** (~2,000 metered-calls/hr over an honest ~600–800 busy-hour estimate); vision cost sized per-image-tile.
- **Beta calibration stated** — thresholds ship as fixed defaults validated against the §F fixtures; the 6b golden set is the formal retune (no silent drift, no reclassification of historical rows).
- **Tables namespaced `aso_`**; **ASA "Search Match" conflation** corrected; **§D evidence** reworded to "reconstructable" (matches the schema).

## What's new in v1.2.0 — build-ready

Closing the gaps a reviewer (and the codebase) surfaced, so an engineer can execute without coming back to ask:

- **Identity Resolution split** into **ID-lite** (deterministic, day-one signals, runs in the beta) and **ID-full** (vision + audience, folds into P2) — removing the forward dependency on storage and vision that didn't exist yet.
- **P5 spend cap reconciled** — the enforced control is the count-based loop kill; the dollar cap is an honest **post-hoc estimate/alert** until token accounting is wired (P7). No more "real control" overclaim.
- **P6 decomposed** into **6a (correctness gates at user #2)** and **6b (scale-out at ~1K)** — honouring "one wall at a time."
- **P8 stop-loss** given a concrete metric + threshold + noise band (it was acting on a signal the spec calls correlational).
- **ASC auth corrected** — JWT (ES256, .p8 key), not OAuth; Apple Search Ads (P3) is the OAuth2 one.
- **AppKittie** competitive **data-egress** risk named (not just replaceability).
- **New [Build Appendix](#build-appendix)** — data-model schemas, seam interface contracts, recommendation-dedup + intent taxonomy, the evidence-trail type, per-phase acceptance criteria, and a spec→code map (including the code reconciliations the build must make).

## What's new in v1.1.1 — fact-check corrections

Claims tightened to match sources after a review pass:

- **Screenshot OCR** reframed as **contested**, not "Apple doesn't OCR" (June-2025 industry shift vs. counter-evidence, sourced).
- **iTunes ~20/min** now cited to Apple's own [iTunes Search API docs](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html), plus an Akamai cache-staleness note.
- **Icon sizes** corrected — 1024px master (not 512), 87px is the Settings icon, search-thumbnail px is undocumented; pHash split into observed vs. inferred.
- **Measurement** signals matched to change type (rank for metadata, ratings/reviews for experience, diff/PPO for visuals).
- **"Can't measure two changes at once"** reframed — ship freely; the rule limits claims, not shipping (PPO = visual-only causal proof).
- **Screenshot reorder** narrowed to non-panoramic **slot-promotion**, not free shuffling.
- **Persistence** corrected to LibSQL → Postgres at P6 (the stray "Postgres from day one" removed).
- **Added:** rollback mechanics, the pending-version / baseline / go-live model, human-override boundaries, and an explicit **iOS-only scope** deferral.

## Shipped in v1.1.0

- **Paid Gemini + cost model** (see *Cost & Courtesy Control*) — the base LLM moved from Ollama to paid Gemini; Phase 5 gained a cost model (the enforced control is the count-based loop kill; the dollar figure is a post-hoc estimate until token accounting lands at P7 — see v1.2.0).
- **External services & tooling** (see *The principle, and what we'll need*) — every dependency mapped by phase (data/APIs + infrastructure), with the MCP discipline.
- **The paid-provider bake-off** (see *Keyword Research*) — AppTweak vs AppFigures vs AppKittie compared, with the Phase-3 pick; keyword mechanics are now per-script (i18n).
- **Identity Resolution, deepened** (see *Identity Resolution*) — now also resolves the target audience.
- **Edge cases** (see *The Always-On Advisor* and *The principle…*) — underpowered apps (PPO significance) and low/zero-data degradation.
- **Offline recommendation-quality eval** (see *Multi-Tenant Alpha*) — named as part of the alpha hardening.

---

## Where we are, and where this goes

The current agent audits an App Store listing across 10 dimensions and returns a score plus recommendations. It works, but it has no memory: run it twice and it can contradict itself, because it doesn't know what it said last time or whether anyone acted on it.

Each phase below is a self-contained step that ships something usable on its own. We start by **grounding what the app actually is** (so we never optimise the wrong product), then give it **memory** — the foundation everything else builds on — then deepen what the agent can **observe** (images, keywords, reviews), then make it **safe to run** without getting throttled by the APIs it calls or running up a bill. The destination is an always-on advisor that sends a daily digest. The north star — **proving a change actually worked** — is sequenced last by necessity, not neglect: real measurement needs a connected App Store Connect account, so the beta first proves the loop **closes honestly** on public signals, and true measurement is wired the moment that data is available.

**How we phase — earn each tier before you build for it**

This discipline runs through the whole plan: **we don't build for a scale we haven't reached.** The beta proves the loop closes and remembers — honestly — for a single operator, on the simplest infrastructure that works. Only then do we scale, and each tier crosses **one specific wall**, never all of them at once.

- **1 user · the beta** (ID-lite grounding + Phases 1–5, with ID-full folding into P2 + net-new). Prove the loop — ground what the app is → observe → diagnose → recommend → remember → re-observe. LibSQL, in-process, paid Gemini (pennies at one-user volume). The **seams** get built here; nothing premature gets built behind them.
- **→ 1K · become a service** (Phase 6). The first wall: the in-process shortcuts that are right at one user — one pacer, one tally, one process — break the instant a second instance exists. Auth, isolation, shared limiters, a durable queue.
- **→ 5K · turn the loop on** (Phase 7, API integration v1 — read & connect). App Store Connect connects, tracking runs continuously, and "did it actually work?" finally has a real answer. Cost economics become first-class.
- **→ act · teach it to write** (Phase 8, API integration v2 — track-record-gated). Once the ledger has earned trust, the agent applies changes — through App Review's slow submit-and-rejection loop for gated fields, and directly on the surfaces that need no review.
- **→ 10K+ · the north star.** The always-on advisor: a daily digest that puts human decisions first, with visual wins **proven** by Apple's own A/B test, not asserted.

We never re-platform what we can put behind a seam. The beta builds those seams — a swappable storage client, one provider interface per source, an entity-keyed cache — and scaling fills them in rather than rewriting them.

---

## The plan at a glance

| Phase | Name | What |
|---|---|---|
| ID | Identity Resolution | What is this app, really? Ground the true identity before diagnosing — so Rivian maps to the Tesla app, not Booking.com. **ID-lite** (deterministic) runs in the beta; **ID-full** (vision + audience) folds into P2. |
| Phase 1 | Persistent Memory | The agent remembers every audit and every suggestion. |
| Phase 2 | Image Analysis | Do the screenshots and icon actually fit the product? |
| Phase 3 | Keyword Research | High-volume, relevant keywords from real search-volume data. |
| Phase 4 | Deep Review Analysis | Mine reviews for themes and turn them into moves. |
| Phase 5 | Cost & Courtesy Control | At one user there's nothing to rate-limit: cache, a spend/loop governor, and not getting banned. |
| + | Net-new uplifts | Standalone wins the single-user shape unlocks — storefront sweep, honesty manifest, export. |
| P6 · →1K | Multi-Tenant Alpha | Become a service, in two stages: **6a** correctness gates the 2nd user forces (auth, isolation, shared limiter, Postgres swap); **6b** scale-out ~1K justifies (durable queue, horizontal workers, observability, eval). |
| P7 · →5K | Connected & Always-On | App Store Connect (API integration v1: connect + read) + continuous tracking — the loop goes live and "did it work?" gets a real answer. |
| P8 · v2 | Acting on the Listing | API integration v2: apply changes through App Review, handle the rejection loop, act on the no-review surfaces. |
| ★ · →10K+ | The Always-On Advisor | The north star: a daily digest, visual wins proven by Apple's A/B test, measured outcomes. |

---

## ID · Identity Resolution — what is this app, really?

Before the agent diagnoses anything, it has to know what the app actually **is** — or it optimises the wrong product. Rivian's app manages electric vehicles, but it presents as Travel (maps, range, trip metrics), so an audit that trusts the listing picks Booking.com as a competitor when the real peer is the Tesla app. This step grounds a true identity from many signals, surfaces the gap between what the listing **says** it is and what it **does**, and only then lets the audit run. It is the first thing every audit does at runtime; its output is saved into the memory of Phase 1.

**Built in two stages, because it depends on things later phases bring.** Identity is described here in full, but it ships in two parts so the build order is honest:

- **ID-lite — the beta default.** The deterministic, day-one signals that need nothing but the iTunes Lookup response and one crawler fetch: developer + their other apps, bundle-id reverse-DNS, permission/privacy labels, IAP names, marketing-domain match, and review-vocabulary. Pure-code matching, no vision. ID-lite **stands up the identity store** (it is the first writer into the P1 memory tables) and produces a category/niche with a confidence tally. This is what runs first in the single-user beta. **ID-lite and P1's storage scaffolding ship as one build unit** — ID-lite has no standalone existence before the `StorageClient` lands, so the phase table's "ID before P1" is a *runtime* order, not a "build ID against a store that doesn't exist yet" instruction.
- **ID-full — folds into P2.** The **vision-grounded** identity (does the creative match the function?) and the **audience** resolution depend on the P2 vision pass, so they attach when P2 lands. Until then, ID-lite's identity is stamped "no-vision" and the vision-dependent escalations are simply not raised.

The confidence ladder, the two-axis model, and the human-escalation logic below apply to both stages; ID-full only *adds* signals, never reinterprets ID-lite's deterministic ones.

**What we build — resolve identity from many signals**

- **The signal stack, strongest first.** The developer's identity and their other apps; the bundle id reverse-DNS (com.rivian.*); the permission & privacy labels and device capabilities (Bluetooth, location, CarPlay → a companion-to-a-device, not a travel agency); in-app-purchase names; the marketing/support URL's own page (fetched and **cited**); the review vocabulary (what users say they actually **do** — "precondition my truck", "check charge"); and the off-store footprint, cited.
- **World-knowledge is a prior, never a verdict.** That an LLM or Google "knows" Rivian makes EVs is a useful hint — but it must be corroborated by a fetched, citable signal, can be stale, and may describe the **company**, not the **app**. We never trust it blind.
- **Fed to the model as an authoritative identity fact sheet.** The resolved identity is injected into the scoring prompt the same way the deterministic signals are — so the model **interprets** a grounded identity instead of **inventing** one from misleading screenshots.
- **Competitors anchored on function, not the listed category.** Peer discovery runs on what the app actually does (Rivian → the Tesla app), with a **disagreement guard**: when the category-derived set (Booking.com) and the function-derived set (Tesla) diverge sharply, that disagreement is itself the signal — we trust the function-grounded set and flag it.
- **The gap is a finding.** "You present as Travel; your developer, permissions, and reviews say EV-companion — that likely costs you the users searching for your real function." Surfaced as a positioning recommendation — **without over-correcting**, because the brand's business is not the app's function and the app may legitimately serve its category.
- **Resolve the target audience too.** The same pass reads **who the app is for** — audience segments, their pain points, and the exact vocabulary they use (mined from reviews) — because keyword, metadata, and creative all consume it downstream. It rides signals we already fetch, so it is nearly free.
- **Ships on signals we already have.** The iTunes Lookup response already returns the bundle id and the developer's URL — we just don't keep them yet; the rest is pure-code matching and the existing crawler pointed at one extra page (**ID-lite**), with the Phase-2 vision pass joining as **ID-full**.

**No footprint? A confidence ladder, not a cliff**

Resolution walks an ordered ladder and stops at the highest tier whose signals are present — and the tier reached **is** the confidence story, because each tier caps the ceiling: external corroboration (search, Wikipedia) → cross-store listing + reviews → the fetched first-party landing page → on-store-only. A no-footprint startup simply **starts lower on the ladder** — normal, not an error — and on-store-only resolution is structurally barred from "high," because agreement among an app's own first-party signals is not independent corroboration. The day-one signals still fire: the bundle id raises confidence when its org segment matches the registrable domain of the fetched landing page (com.acmebank.* + acmebank.com → "Acme Bank companion"), while a vanity id (com.app.myapp) yields nothing and says so.

**Absence is information, not "we failed to look."** Every external probe records one of three states — corroborated, searched-and-empty (the lookup ran and genuinely found nothing — consistent with a brand-new app, a small honest confidence penalty), or errored (timed out / blocked / 429 — a defect to retry). "No footprint exists" is never allowed to masquerade as "the lookup broke," and the ambiguous case fails safe to "couldn't check."

**Save the findings — versioned, reused, human-overridable**

Identity and the competitor analysis are a **stored, append-only, versioned artifact** in the Phase-1 memory, keyed by app + country — so identity *can* be resolved per storefront when needed (a localised listing can legitimately read differently market to market). The cheap storefront sweep, though, is **observe-only and inherits the primary storefront's identity** — full per-country re-resolution (which needs the crawler + web-search, not just free iTunes calls) is opt-in, never the default sweep. Each identity field carries its provenance, source tier, and confidence band; each competitor carries the **basis** that justified it, so a category-only peer is weak by construction and a wrong one is auditable — and a peer a human has rejected is tombstoned, never silently re-surfaced. The tombstone is **app-scoped** (`app_id + country + competitor_app_id`), not tied to the identity version — so a rebrand that writes a new identity version still inherits every prior rejection, which is what makes "never re-surfaced" actually hold across versions.

**Reuse, don't recompute.** Identity is read first every run; if the identity-bearing signals are byte-identical, the stored identity is reused verbatim at its stored confidence with **zero LLM**. The byte-identity check reads through to each signal's **`fetched_at`/freshness**, not the cache layer — so a stale-but-cached listing (P5) can never look "identical" and silently suppress re-resolution of a changed identity. Only signals that moved get re-resolved, and only the level they feed — so a new anime banner re-resolves **only the niche**, starting from the stored "major RPG, anime is style not category" prior, and can't re-trigger the mis-niche. A rebrand or pivot writes a new version, visible as an identity change over time. A **human override is the highest-priority signal** — sticky, recorded as a categorical "human-confirmed" tier (not a fake 100%), respected by every future audit, and re-asked only when the signals it rested on materially change and the answer actually flips. An override steers **interpretation** — it can legitimately make future audits point a different way, and that's the feature — but it **cannot rewrite the historical record, change a measured outcome, or be laundered into "observed evidence."** The interpretation layer is the operator's to steer; the observation and measurement layers stay **append-only and read-only to everyone.**

**Confidence, and when we ask a human**

Confidence is a **counted, citable tally**, never a fabricated percentage: "**N of M independent signal families agree**" (developer, bundle-id, permissions, IAPs, marketing-domain, cross-store, reviews, footprint), each resolvable to its source, weighted observed-on-store ≥ fetched-and-cited > review-inferred > world-knowledge prior (which never counts alone) — the exact tier weights are in the [Build Appendix](#build-appendix) §E. It is **two axes, never averaged**: broad category and specific niche. Genshin Impact's category is certain (genre + gacha purchases + reviews all agree) while its niche is not (anime art pulls toward "anime app") — so we say "category: high / niche: low" verbatim, never a misleading middle.

**Conflict yields low, not averaged.** When two individually strong, independently-corroborated signals point at different identities, that is the clearest sign we don't know — confidence drops to the escalate band. The declared store category alone is a single signal, not "strong" by default. Divergence is an **ordinal band** on two citable category strings: none (Genshin: Games == Games), within-domain (Productivity → note-taking: a note, never an escalation — the app legitimately serves its category, so we do not over-correct), or cross-domain (Travel vs vehicle-control — the only band that escalates).

Bands: high → proceed; medium → proceed but flag; low / conflict → ask a human. The concrete **weighted-tally thresholds** that map signal families → band (so "given these signals, the band is X" is a writable acceptance test) live in the [Build Appendix](#build-appendix) — the tally is *weighted* (tiers count for different amounts), not a raw headcount. Escalation is **asymmetric** to keep the gate rare: a low niche under a high category only adds a flag — it never blocks. The hard gate fires only when the category itself is low, the two axes truly conflict, or a high observed function sits over an inferred-only niche. The ask reuses the audit's existing confirm step (today "is this the app you meant?", widened to "here's what we think your app is and who it competes with — confirm, correct, or pick a candidate"), batched into the digest's "decisions that need a human" block — TikTok and Spotify generate zero asks. If the human never engages, we proceed at best guess but **code-suppress the identity-rewriting recommendations** (the confident "rewrite your subtitle around vehicle control" is withheld; quick-wins like "add a preview video" still ship) and stamp the audit "identity unconfirmed" — silence is never read as a yes, and low confidence is never read as a human decline.

**The hard part**

Telling **"the listing mis-frames the app"** apart from **"the app genuinely serves this category"** — and scoring that confidence without inventing precision. Over-correct and you rewrite a legitimate trip-planner into a car app; under-correct and you keep advising Booking.com. The resolution is to count evidence rather than assert, treat conflict as low confidence, and route the genuinely ambiguous middle to a human rather than guess.

**What we show**

Audit Rivian: the system reports "presents as Travel, but developer + permissions + reviews say EV-companion — real peer is the Tesla app, not Booking.com," with an identity-confidence and, because the signals conflict, a one-click human confirm. Audit a no-footprint startup: a "provisional identity, low corroboration" label instead of a confident wrong guess. Re-audit either one: the confirmed identity is reused, not re-litigated.

---

## P1 · Persistent Memory

Give the agent a memory so it can recall all past audit information and every suggestion it has made — and stop contradicting itself.

**What we build**

- A **per-app history**: each audit run stored as a snapshot (listing data + 10-dimension scores + the report), keyed by app ID + country.
- A **suggestion ledger**: every recommendation recorded with its status — proposed, applied, or dismissed — plus the evidence behind it.
- On a new audit, the agent **reads its own past output first**: it can say "you applied this, here's the new state" instead of starting from zero.
- Every recommendation carries an **evidence trail** — a link back to the exact observed signal that produced it, so the advice is auditable, not asserted.

**How**

Memory must live in **persistent storage** — it has to survive restarts and deploys, or it isn't memory. In beta we use **LibSQL**, in-process: it gives real persistence with no external service to run, secure, or pay for at one-user volume. Add a small **memory** module with the tables defined in the [Build Appendix](#build-appendix) and inject the relevant history into the agent prompt before it scores. Mastra's storage primitives support both LibSQL and Postgres *(assumption to verify against the pinned Mastra version before P6 — the whole "config change, not migration" claim rests on it)*.

The store sits behind one swappable client, so the agent code never depends on the specific database. When P6 brings concurrent workers and shared state, the client swaps from LibSQL to **Postgres** — a config change, **not a migration**, precisely because the seam was there from day one *(this rests on the storage-client contract in the Build Appendix holding; a schema or transaction-semantics gap between the two engines is the risk to retire early)*. We don't run a multi-node database before there's concurrency for it to serve.

**Uplift — now, not future**

- **Applied-detection without App Store Connect.** We already re-observe the public listing on every audit. When a past suggestion shows up in the new listing, mark it applied automatically ("applied" means the listing now **matches** the suggestion — *not* that we **caused** the change; causation is the P7 measurement window's job) — then watch the signal that actually *matches* the change, not whatever is easiest to see. **Metadata** edits (subtitle, keywords, title) move discovery, so the only public proxy today is **keyword-rank drift** — true impressions/conversion needs App Store Connect at P7. **Experience or review-response** changes are what move **ratings, review volume and sentiment**. **Visual** changes show up as **screenshot/icon diffs** (provable only by a PPO A/B test). Matched to the change, it's a real, directional **measurement loop available today** — not Apple's provable A/B test, but the first honest answer to "did it actually work?", with metadata explicitly marked *not fully measurable until P7*.
- **Change diff — what moved since last audit.** A plain changelog: listing edits, score deltas, rating drift. This is what makes memory feel like memory rather than a log file.
- **Contradiction guard.** Before emitting, the agent checks new recommendations against the ledger and refuses to reverse past advice without flagging the change — directly killing "run it twice, it disagrees with itself."
- **Snapshot store + rubric replay.** Every audit writes an immutable snapshot — listing, the deterministic signals, the report, the prompt hash and model id. Retune a rubric **weight** and re-run the assembler over every stored draft for an exact, instant, zero-LLM "how would the score have moved." Re-**judging** an old listing with today's model is a separate action, stamped "re-judged, not the historical verdict."
- **Clickable evidence trail.** Make each claim's evidence a typed reference — a signal, a listing field, a specific review, or an explicit unavailable — frozen into the snapshot. A chip resolves deterministically into that date's source data, so a claim can never be mis-pointed or back-dated.

**Secondary uplifts:** per-dimension sparklines (deterministic signals solid, LLM scores muted); belief accumulation per recommendation against a fixed intent taxonomy ("raised in 3 of your last 4 audits, never dismissed" — reconstructed from the `aso_rec_occurrences` table, which records per-audit presence/dismissal, since `first_seen_at`/`last_seen_at` alone can't capture an intermittent raised→dismissed→raised pattern); a next-best-**one**-move discipline; and a correlational public-signal delta panel — the honest, account-free precursor to self-measurement.

**The hard part**

**Identity and dedup.** Matching "the same recommendation" across runs (so we don't re-suggest what's already applied), and handling a listing that changed between audits. Get this wrong and memory makes the contradiction problem worse, not better.

**What we show**

Audit the same app twice — the second run references the first, shows what changed, marks which past suggestions were applied, and never repeats one.

---

## P2 · Image Analysis

Look at the actual screenshots and icon and judge whether they make sense for the product — the first impression a user reacts to before reading a word.

**What we build**

- Pull **full-resolution screenshots and the icon** (already available free from the iTunes artwork URLs) and run them through a **vision model**.
- Assess: value-prop clarity in the **first one or two frames**, icon legibility at thumbnail size, readability of on-image text, and visual cohesion with the product's category.
- **Competitor visual benchmarking**: run the same vision pass on the top competitors' first frames, so the critique is positioned — "your lead screenshot is text-heavy; the top three lead with product UI" — not judged in a vacuum.
- Output **ranked variant hypotheses to test** — "this caption is hard to read at search-result size" — never flat verdicts.

**How**

A vision-capable model (Gemini or Claude vision). Each image is scored on the criteria above with a confidence label, then folded into the existing screenshots/icon dimensions.

**Uplift — now, not future**

- **The icon as a searcher actually sees it.** Downscale the **1024px master** to the small sizes a user actually encounters — home-screen 120/180px, and the App Store search thumbnail (Apple doesn't publish its exact render px, so we test a small range ~80–120px) — rather than judging the pristine upload. Compute a deterministic fact sheet first — perceptual-hash distance to each competitor's icon, dominant-colour palette, busy-ness at thumbnail size — then let vision critique legibility on those true small pixels. The pHash distance is an **observed** number; "under 8, *likely* confusable in a search row" is the **inferred** hypothesis it supports — flagged as such, not asserted as fact. *(Icon sizes per [Apple HIG — App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons); 1024px master + per-context render sizes corroborated by [SplitMetrics](https://splitmetrics.com/blog/guide-to-mobile-icons/) and [IconikAI](https://www.iconikai.com/blog/ios-app-icon-size-guidelines-guide). Apple does not publish the App Store search-row render px.)*

**Secondary uplifts:** screenshot-set intelligence (role-tag each panel, flag duplicate messages, and — for **non-panoramic sets only**, since reordering breaks a continuous panorama — propose **promoting the strongest panel into the search-visible slots**, no new art; Apple documents only that *up to three* screenshots may show in search, so slot order is treated as an industry-backed lever, not an Apple-stated rank rule); a cross-device / cross-locale consistency matrix (slot counts are pure code, vision rides on top); and a variant brief that enforces PPO's **≤3 non-overlapping treatments** up front, so the creative is independently measurable later.

**The hard part & a contested claim**

Whether Apple OCR-indexes screenshot text for search is **contested, not settled** — so we don't assert either way. Apple's [search docs](https://developer.apple.com/app-store/search/) list only title, subtitle, keywords, and category as indexed text, and Apple has never confirmed or denied reading on-image text; a June 2025 algorithm shift led much of the ASO industry to conclude Apple began OCR-indexing caption text as a **low-weight** signal ([Appfigures](https://appfigures.com/resources/guides/app-store-algorithm-update-2025), [SplitMetrics](https://splitmetrics.com/blog/apple-app-store-ranking-factors/)), while an empirical 8-app test found **no strong evidence** of broad indexing ([ConsultMyApp](https://www.consultmyapp.com/blog/-is-apple-now-indexing-screenshot-titles-on-the-app-store)). So we treat on-image text as primarily a **conversion lever** and any keyword value from it as a **hypothesis, not a fact**. Visual quality is subjective regardless: we frame every creative change as a testable hypothesis, because only an A/B test proves one worked.

**What we show**

An audit where each screenshot gets a specific, confidence-labelled critique and a concrete suggested variant.

---

## P3 · Keyword Research

Find the keywords that are both high-volume and genuinely relevant to the product — backed by real search-volume data, not a model's guess.

**What we build**

- **Candidate generation** from the listing text, the language users use in reviews, and competitor metadata.
- **Volume + difficulty scoring** for each candidate from a real data source, then a ranked opportunity list.
- **Gap analysis**: relevant, winnable terms the listing isn't targeting, with before/after metadata suggestions.

**Search-volume tools — recommendation**

| Tool | Signal | Cost / note |
|---|---|---|
| **Apple Search Ads** popularity | Apple's own 5–100 search-popularity score | Free with an ASA account — most authoritative. **Start here.** |
| **AppTweak** | Volume, difficulty, rank, suggestions | Paid; richest coverage, ships an MCP |
| **AppFigures** | Volume, rank, revenue | Paid; cheapest, documented API |
| **AppKittie** | Volume, difficulty, rank leaderboards, revenue/ad intel | Paid (~$49/mo); indie, ships an MCP |
| **Sensor Tower** | Volume + competitive intel | Paid; enterprise-grade |

Recommendation: **build against Apple Search Ads popularity first** (free, authoritative), then run a **bake-off** among the paid providers only where Apple's signal runs dry. Several now ship an MCP — convenient on our Mastra stack, but that is **not** a reason to pick one. Any provider — **AppKittie included — is one option behind a single swappable client, never a required dependency**.

**Access mechanism, named (it's not just "free with an account").** The 5–100 popularity score comes from the **Apple Search Ads API**, which authenticates via **OAuth2 client-credentials** (an ASA account; the `client_secret` is itself a signed JWT; scope **`searchadsorg`**) — distinct from the App Store Connect API's JWT auth at P7. It is a relative **search-popularity** score (the 5–100 keyword-popularity indicator) — *not* Search Match, which is ASA's auto-targeting feature, a different thing; it requires an active ASA account (no spend required to read popularity, but the account and API enrolment are a real setup step). **Bake-off trigger, made concrete:** pull a paid provider only when (a) a target term returns no ASA popularity, or (b) we need rank-position or competitor-keyword data ASA structurally cannot give.

**The CJK / RTL script-aware fallback, defined.** "Falls back to a script-aware path" means: detect the storefront's script; for CJK, **skip the space-delimited tokeniser** and use character-n-gram candidate generation with no plural/word-length rules; for RTL, normalise direction before length counts. Until that path is implemented, non-Latin storefronts run **observation-only** (utilisation, parity, counts) with keyword-mechanics findings suppressed and labelled "script not yet supported" — never emitted as low-confidence guesses.

**The three paid candidates, compared**

If Apple's free signals run dry, three providers lead the bake-off. In one line each: **AppTweak** — a deep, mature ASO intelligence platform (built for ASO pros/agencies); **AppFigures** — an app-analytics/reporting tool at heart (connects your own store accounts) with ASO layered on; **AppKittie** — a newer market + ad-creative intelligence tool (AI-era).

| Dimension | AppTweak | AppFigures | AppKittie |
|---|---|---|---|
| **DNA / origin** | Pure-play ASO platform | Developer analytics aggregator → added ASO | Market-intel DB + ad-creative + AI |
| **Core strength** | Deepest keyword volume/difficulty + rank tracking + competitor data | First-party actuals — connect your App Store Connect / Play accounts for real downloads/revenue, cross-store, well-documented API | Broad app DB with revenue/download estimates + ad-creative & UGC/influencer intelligence + AI screenshot generation |
| **Only it gives you** | Semantic competitor discovery ("Atlas") + the most-validated keyword models | Your own multi-store numbers as ground truth (not estimates) | What ads/creatives competitors run, and the creators behind their growth |
| **Data method** | Large panel + Apple data + mature modeling | Your connected accounts (actuals) + estimates for others | Its own panel / estimation |
| **Maturity** | Highest (years, trusted) | High (long-standing dev tool) | Newest / least-proven |
| **Store coverage** | iOS + Google Play, global | iOS + Play (+ Amazon) | iOS-primary (some Play) |

**Likely Phase-3 pick: AppKittie** — not because it's the best data (AppTweak is), but because the trade-offs point there for us. AppTweak has the deepest data but a premium API (~$166/mo floor) that's hard to justify at our scale; AppFigures' signature strength — your own first-party numbers — is data **App Store Connect already gives us** for free at P7, so we'd be paying for an overlap. AppKittie is the cheapest and most MCP-native, with ad-creative intel as a bonus. We adopt it **behind the swappable seam, as a commodity input** — mindful that it is also our **closest competitor**, so it stays non-load-bearing and trivially replaceable.

**The competitor-egress risk — separate from replaceability.** Querying a competitor's API tells them which apps *our customers* care about — a data-egress / competitive-intelligence leak that a swappable seam does **not** mitigate (you can swap the provider, but the queries already left). Two facts bound it: the app ids we'd query are **already public** (anyone can look up any app), so a single lookup leaks little; the real exposure is **pattern** — batch-querying our whole customer portfolio reveals our customer base. **Decision (default — override if you disagree):** query AppKittie only by public app id, never in customer-identifying batches (interleave/anonymise the query stream); treat this as a ranking input in the bake-off, not just price/MCP-fit — and if competitor-intel egress ever becomes material, prefer a non-competitor provider (AppTweak/AppFigures) for the load-bearing queries.

**Market & ad-creative intelligence — bounded**

The same paid-data integration also exposes **revenue, download, and growth estimates** and **competitors' ad creatives**. We use them narrowly: market/growth estimates to **weight a competitor's significance** (is this peer big or surging?) and to **prioritise recommendations** by opportunity size; ad creatives as **conversion hypotheses feeding image analysis** (what messaging rivals pay to test). All labelled estimates. **Revenue optimisation and ad/UA optimisation themselves stay deferred neighbour channels** — we read these signals, we don't build those products.

**Uplift — now, not future**

- **The 160-char indexed-surface linter — in pure code.** Run Apple's field mechanics deterministically over title (30) + subtitle (30) + keyword field (100): dedupe tokens across fields (Apple tokenises them together), flag plural-redundant candidates, and catch wasted words ("app", the brand, the category name) — emitting a per-term ledger with reclaimable characters. The keyword field is unobservable, so its findings are inferred and conditional; only title+subtitle overlap is observed. This is the shared, unit-tested engine the next three uplifts all call.

**Secondary uplifts:** keyword-gap buckets vs competitors (shared / yours-only / theirs-only, weighted by peer frequency); a brand-vs-category demand split of the observable surface; an Apple-free rank probe run as a **time series with a documented noise band** (an observed range, never a false-precise "position 7"); and a reclaim simulator that recounts the operator's own candidate copy live — deterministically, no model call.

**The hard part**

A competitor's actual **keyword field is never observable** — we infer it, and we must label that clearly. Keyword wins are also correlational, not provable: there's no holdout test for metadata. We report this honestly rather than selling guesses as facts.

**Script matters, too.** The linter's rules are **Latin-first** — its word-splitting assumes spaces and word length, which breaks for CJK (character-based, no spaces — Apple tokenises it differently) and for right-to-left scripts. Keyword mechanics, on-image-text reads (P2), and sentiment (P4) are all **per-script**; non-Latin storefronts fall back to a script-aware path and are labelled lower-confidence until it exists.

**What we show**

A ranked keyword opportunity list with real volume scores and concrete metadata edits.

---

## P4 · Deep Review Analysis

Go beyond the star rating: read the reviews, find what users actually love and complain about, and turn that into actionable moves.

**What we build**

- **Theme extraction**: cluster reviews into praise themes, complaint themes, and feature requests, with a sentiment trend over time.
- **Routing into the loop**: complaints become visual/metadata hypotheses, the words users use become keyword candidates, and feature requests are flagged as a **human hand-off**.
- **Actionable suggestions** with before/after text, each tagged by where it routes and how confident we are.

**How**

An LLM pass over the review corpus the project already fetches (iTunes RSS), producing themes and routed suggestions. For a connected app, App Store Connect gives a deeper review history later.

**Uplift — now, not future**

- **Per-version sentiment delta — did the last release fix it or break it?** Group the review sample by the app-version field Apple already ships and chart the rating + complaint-theme shift across the two most-recent versions: "your latest sample shows the crash complaint gone but a new login complaint emerging." **Prerequisite:** raise the review fetch from its current default of 25 toward the ~500/country cap first (this cap is **industry-observed, not Apple-documented** — treat it as a working assumption) — otherwise the prior version falls below a readable sample and the delta collapses.

**Secondary uplifts:** cross-country complaint divergence against one shared theme taxonomy (so "divergence" isn't just inconsistent labelling across languages — and this **canonical theme taxonomy is also what gives `fix_complaint_theme` recommendations a stable `value_key` across audits**, per Build Appendix §C, so it is **beta-critical for dedup**, not merely a cross-country nicety); competitor review mining for positioning gaps; and helpfulness-weighted theme salience using the vote fields the RSS feed already carries.

**The hard part**

**Sample bias.** The free RSS feed returns only recent reviews, skewed toward the loudest voices. We weight by recency and volume and state the sample we actually saw — never imply we read every review.

**What we show**

A themed review summary where each complaint and request becomes a concrete, routed recommendation.

---

## Net-new uplifts — what the single-user shape unlocks

Not phases of their own — standalone wins that being one user (no multi-tenancy, no public access, your own app's data) makes cheap and honest right now.

**Uplift — now, not future**

- **Storefront sweep — one app across countries.** Re-run the observation layer for the same app across an operator-chosen set of storefronts (us / gb / de / jp) using only free iTunes calls — the resolver already takes a country param. Surfaces the highest-leverage finding small teams miss: **shipping the US listing untranslated to every market.** A zero-dependency tier (title utilisation, screenshot-count parity, rating spread, availability) always runs; subtitle/promo "localised vs US fallback" rides on the crawler when present. **Runs as sequential per-storefront sub-runs**, each its own audit under its own 5-min cap and pacer — a sweep is *N* audits, never one monster run that trips the wall-clock cap (see the call-budget note in P5).
- **Connect-to-measure honesty manifest.** A pure-code map of every recommendation into four proof regimes — provable later via Apple PPO (icon, screenshots, video), correlational forever even with an account (title, subtitle, keywords), funnel-measurable via App Store Connect (conversion), and observable now via re-audit (ratings, competitive). It turns the honesty discipline into a visible surface and pre-wires the single most important future event — connecting an account — without requiring it today.

**Secondary uplifts:** a portable audit + evidence export (Markdown / PDF — a **persistence-independent** artifact the operator can keep or share, not contingent on the database); and a review-vocabulary keyword miner that counts the full review sample in code and hands the ranked gap to the model as an authoritative signal.

**What we show**

One US URL in, four storefronts back: "GB title 18/30 chars; JP has no localised screenshots; DE rating 4.1 vs US 4.6" — with one recommendation per gap, and a per-recommendation panel naming exactly how each would be proven.

---

## P5 · Cost & Courtesy Control

At one user there is **nothing to rate-limit**. No inbound traffic, no second caller, no fleet to arbitrate. A production rate limiter answers "how do I protect my service from my clients?" — a problem that **cannot occur here**. The real job is smaller and sharper: don't get banned, don't get billed by surprise, and don't re-fetch what hasn't changed. Three small local pieces — a cache, a spend/loop governor, and a courtesy throttle — replace the entire rate-limiter frame.

**The real threat — outbound and financial**

- **Apple soft-bans the egress IP.** Lookup, Search and the review RSS share one IP. Apple **documents** "~20 calls/min (subject to change)" for the **Search API** (the [iTunes Search API docs](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html)) — and **Lookup is part of that same API**, so the limit covers it. The **review RSS feed is a separate endpoint with no published limit**, so we apply the same ceiling to it as a **conservative assumption, not a documented fact**. A competitor sweep or a tight dev loop trips it and blinds every source at once. Separately, Lookup serves **Akamai-cached responses** (observed cache up to a few hours, IP-pinned), so the feed can be stale — handled by our own TTLs and a cache-buster, below.
- **A runaway loop — bounded by count, not dollars.** A re-entrant workflow or a dev hot-reload can fan out calls indefinitely. The default LLM is **paid Gemini** — cheap per audit (pennies at one-user volume) but **metered from day one** — so a runaway loop is now both a real (if modest) bill and an IP-ban risk: an unattended overnight loop hammering Apple's IP, compounding Gemini calls, and burning crawler credit. The **enforced** backstop is a **call-count kill**; a **dollar cap rides alongside as a post-hoc estimate/alert** (see the governor row for why it can't be the hard gate yet).
- **One real concurrency nuance.** The confirm step suspends and resumes, so two browser tabs can yield a few overlapping in-process runs sharing one IP and one tally. Handled by a single **guarded in-process singleton** — not a distributed limiter.

**Call budget for the widest single run.** A single deep audit's worst case is bounded: iTunes core (~3–5 calls) + competitor benchmarking (top-3 × ~2) + review fetch (~10 RSS pages at 50/page for ~500 reviews) ≈ **20–25 iTunes calls**. At the ~3.5s pacer that's ~70–90s of spacing — under the **5-min per-run cap**, but the review-fetch pages are the bulk, so the cap is sized for *one* deep audit, not a sweep. **A storefront sweep is therefore N sequential sub-runs, each under its own cap** (above), not one run — otherwise 4 storefronts × ~22 calls would legitimately brush the wall-clock cap and the honest-degradation path would fire on a feature, not on abuse. Vision/LLM scoring runs **concurrently and is not pacer-bound** (the pacer gates only iTunes), so it doesn't consume the iTunes budget — the 5-min cap holds for a full deep audit including the vision pass.

**The three controls — with concrete numbers**

| Control | What it does | Concrete |
|---|---|---|
| **Cache** (the dominant lever) | Wrap the HTTP helper and the LLM/vision calls; a served-from-cache field stamps its provenance observed-from-cache + fetched-at, so a re-audit costs ~$0 upstream. | iTunes core **24h**; review RSS **1–3h** (most time-sensitive); competitors **7d**; vision keyed by screenshot-list fingerprint + per-asset SHA-256 with a **~30-day sanity TTL — never "infinite"**. `--fresh` is the documented post-release bypass. |
| **Spend & loop governor** | A count-first pre-flight guard. Refuse the next metered call when a count cap would break; **stop the run honestly** and mark affected dimensions unavailable (cap reached) — never zero-filled or guessed. | **Enforced control = the loop backstop** (the only thing wired today): kill at a per-hour **metered-call ceiling** counting **all metered calls** (iTunes + Gemini/vision + crawler, not just the iTunes calls the pacer spaces). One deep audit is **~40 metered calls** (~22 iTunes + ~8 vision + ~10 per-dimension LLM — the P4 theme-extraction pass does canonical-theme classification in the *same* call, and the rare `other`-bucket embedding fallback is one cheap embedding call counted when it fires — + ~1 crawler), so a busy single-operator hour (≈ 15–20 audits and sweep sub-runs) is **~600–800 metered calls**. The ceiling is set **above** that — default **~2,000/hr** — comfortably clear of legitimate use yet far below a runaway loop (tens of thousands). The **real fast catch is the run-entry <2s trip**, which kills re-entrancy long before the hourly ceiling. **5-min wall-clock cap per audit run.** The **dollar cap is post-hoc** — token usage isn't wired in the beta, so it's an **estimate/alert** (default **$5/day**), not a hard pre-flight gate. Text calls are estimated from request/response sizes; **vision is sized by Gemini's published per-image-tile token cost**, not response bytes — image cost isn't byte-proportional, and vision is the likely dominant driver from P2 on, so a byte-based estimate would mis-price exactly the spiky workload. Token accounting that makes the dollar cap enforceable lands at **P7** (where it becomes the unit-economics model). |
| **Courtesy throttle** (good guest, not gatekeeper) | One process-global serial pacer in front of all iTunes calls (shared IP → shared pacer). Honour Retry-After verbatim; back off on 429. | ~**3.5s** min interval (~17/min, a margin under 20). Backoff with full jitter (base 500ms, cap 30s), but the floor always wins: resume at **max(Retry-After, min-interval)**. In-process coalescing dedupes same-key fetches within a run. |

**What we deliberately do not build — seams only**

- Distributed circuit breakers, multi-tenant quota fairness, durable job queues, horizontal workers, cross-instance token buckets, thundering-herd jitter. Each solves a many-users / many-nodes problem that **cannot occur at one user on one process**.
- The seam we do keep: the cache is keyed **by entity** (app / competitor / asset), never by user, and the governor is a pluggable interface — so "share by entity, shard by credential" and per-tenant budgets drop in the day a second user appears, with no rewrite.

**The hard part**

**Cache freshness vs. staleness** — a correctness and honesty problem, not a concurrency one. A stale read mislabelled "observed" is the same sin as fabricating a number. Two traps: the **review feed** is the most time-sensitive dimension and the post-release re-audit is its whole point (hence the 1–3h TTL plus `--fresh`); and the **vision cache** must key on the screenshot-list fingerprint **and** a per-asset hash, because hashing one image can't detect a reordered or added slot. The resolution is discipline, not cleverness: TTLs set to each source's real change cadence, every cached field stamped with its fetch time and surfaced in the footer, and an explicit bypass.

**What we show**

One screen, one operator, no servers. Run an audit, then re-run it — the second completes in seconds at ~$0 with every field's provenance flipped to observed-from-cache; `--fresh` re-pulls the reviews. Then simulate a re-entrant loop and watch the run-entry backstop kill it within ~2s. Finally, brush the iTunes soft limit on a competitor sweep and watch the pacer space calls ~3.5s apart and honour an injected Retry-After verbatim — three controls proven without a single piece of rate-limit machinery.

---

## P6 · Multi-Tenant Alpha · → 1K users

The first scale wall, and the steepest. Going from one operator to a thousand crosses many "cannot happen at one user" boundaries — but **not all at the same moment**, so to honour "one wall at a time" P6 ships in two ordered stages: **6a — correctness gates that the *second* user forces**, and **6b — scale-out that only ~1K users justify.** The beta was right to take in-process shortcuts; this is where we pay them back. Nothing new about ASO; everything about becoming a service.

**6a · Correctness gates — triggered by user #2 (not by 1K)**

These are not optional and not scale-driven: the instant a second tenant or a second instance exists, the beta's shortcuts become *bugs*. Build these before the second user.

- **Tenancy & isolation.** Auth, accounts, and strict row-level isolation so one user's apps, audits, and ledger are never visible to another. Net-new — the beta had exactly one tenant and never needed it.
- **The in-process singletons go shared.** The beta's pacer, spend tally, and coalescing map all live in one process. The moment we run a second instance, a per-process iTunes pacer means 2× the call rate — the exact IP ban it was built to prevent. They move behind a **shared limiter** (Redis or equivalent). A correctness gate, not polish.
- **Postgres earns its place.** Now there are concurrent workers and shared state, the storage client — a beta seam — swaps from LibSQL to Postgres. A config change, not a migration, precisely because the seam was there from day one.
- **Share by entity, shard by credential.** Two tenants auditing the same competitor cause **one** fetch — the entity-keyed cache from the beta becomes the platform-level dedup layer that keeps the shared APIs (iTunes, crawler, vision) from melting.

**6b · Scale-out — triggered by approaching ~1K**

This is genuine scale infrastructure; building it before 6a is the "build for a scale you haven't reached" mistake the plan warns against.

- **Durable queue + horizontal workers.** Audits (and scheduled tracking) become idempotent, retryable jobs on a durable queue; stateless workers scale out.
- **Observability baseline.** Structured logs, tracing across the loop, and per-provider metrics (latency, error rate, quota use, cost) — so we can see the system before it has problems. (Minimal request logging belongs in 6a; full tracing/metrics is here.)
- **Recommendation-quality eval.** Observability watches the system's **outputs**; this watches its **judgement** — a frozen golden set of audited apps with expected findings, run as a regression, so a prompt or model change can't silently degrade advice. (Named honestly: the beta measures outcomes via the ledger, but not recommendation quality offline — this closes that gap before we let more users in.)

**The hard part**

The shared rate-limit budget. At one user a process-global pacer was enough; across N workers, **iTunes' Apple-documented ~20/min ceiling becomes a shared resource** contended by every worker and every tenant. Get the shared limiter wrong and you either trip the ban (too loose) or starve real audits (too tight). The beta's "good guest" courtesy throttle graduates into a genuine distributed budget — the one piece of production rate-limit machinery we honestly deferred, now built because real concurrency has finally arrived.

**What we show**

A thousand accounts, each isolated; many workers behind a shared limiter that never trips Apple's ceiling; and a view showing two tenants who track the same competitor served from a single cached fetch.

---

## P7 · Connected & Always-On · → 5K users

Until now the system has only ever **observed the public listing**. This phase connects the private data that turns "we think this helped" into "we measured it" — and turns the run-on-demand audit into a loop that runs on its own, every day. Connecting App Store Connect is itself phased: this is **API integration v1 — read & connect only**; writing changes back to the store is a deliberate later step (Phase 8).

**What we build**

- **App Store Connect integration.** Auth is a **JWT signed with a private key (ES256, the .p8 key + issuer id + key id)** — *not* OAuth (that's the Apple Search Ads API, at P3). The funnel comes from the **Analytics Reports API**, which is request-a-report-instance (ONE_TIME / ONGOING), not a live query — so we request the reports, then poll for the generated instance. *(Assumption to verify at P7 kickoff: the exact request→instance→poll lifecycle. Consistent with Apple's documented `ReportRequests → instances` model, but P7-gated — nothing before P7 depends on it, so confirm it then, not now.)* A connected user's real funnel — impressions, conversion, downloads, by source and territory — becomes the baseline we measure against. ASC creds are per-tenant, so this load **shards naturally** — it is not a shared bottleneck.
- **Continuous tracking.** Scheduled daily snapshots of every tracked signal — your listing, creative (by asset hash), reviews, ranks, competitors — with change detection that diffs each snapshot and emits events. The audit stops being something you run and becomes something that watches. Once connected, **go-live is read from App Store Connect's version status + scheduled release date**, not inferred from a public re-scrape — scraping was the pre-account workaround, now kept only for competitor and public-listing verification. The emitted change-events have a defined consumer from day one: they **append to the ledger and surface in the in-app activity view** (the North-Star digest is just a later *delivery channel* over the same event log) — so P7's event stream is never built without a sink.
- **The measurement loop, for real.** A metadata change opens a lag-aware window (industry-estimated ~4-week reindex; Apple publishes no figure) before any verdict; the ledger records what was applied, when, and what moved — finally answering the north-star question with evidence rather than assertion.
- **Cost economics as a first-class concern.** The beta ran on paid Gemini — cheap at one-user volume; at 5K users the bill is real. Model-tiering (a cheap model for extraction/classification, the capable one for judgement), vision gate-on-change, cadence by tier, and per-task budgets with alerting. This is where the usage-counting we instrumented in the beta pays off as a true unit-economics model.

**The hard part**

**Honest measurement of metadata.** Visual changes get a true A/B test (next phase); metadata never can — it reindexes globally per locale over ~4 weeks, confounded by silent algorithm shifts and competitor edits we cannot see. We measure it with synthetic-control / before-after baselines and label it permanently correlational, never proven. Saying that out loud — rather than dressing a correlation as a causal win — is the discipline the whole system rests on.

**What we show**

A connected user's real funnel on screen; a listing change tracked from applied → settled → measured; and a per-audit cost that's predictable because the cheap work runs on the cheap model.

---

## P8 · Acting on the Listing · API integration v2

Phase 7 connected and read; this phase **writes** — it closes the loop's **ACT** step for real. The App Store Connect API can change the listing, but the search-relevant fields are gated by **App Review**, so "apply" is never one call — it's an asynchronous submit-and-wait with a rejection path. This phase handles that lifecycle honestly. It is gated by a **proven track record**, not a user count: we don't write to someone's store until the ledger has earned it.

**What we build**

- **Two write tiers, because Apple has two.** The no-review surfaces — launching a PPO experiment, promotional text, and review responses — can be applied immediately through the API. The App-Review-gated fields — title, subtitle, keyword field, description, screenshots, icon — require submitting a new version and waiting for review. The agent treats these as fundamentally different actions.
- **Gated edits ship as one version, not N writes.** App-Review-gated fields all attach to the next **app version**, so the agent's recommendations and the operator's own edits coalesce into a single **pending-version** object — one submission, one review, one go-live — carrying its release type and target release date. Each change keeps its own ledger entry, but they share that version and its go-live timestamp. The no-review surfaces (PPO, promo text, review responses) are tracked as their own independent objects, not part of the version bundle.
- **The submit → review → rejection loop.** Applying a gated change is a state machine, not a write: proposed → human-approved → submitted → in review → live, with rejected → back to a human as a first-class branch. On rejection we parse the Resolution Center feedback, surface it next to the original recommendation, and never silently retry. Submissions are **idempotent**, so a retry never double-files a version.
- **Human approval stays mandatory for gated changes.** The agent proposes and submits; it does not decide to ship a metadata change on its own. Autonomy is reserved for the no-review surfaces, and even there it is policy-gated and reversible.
- **Apply opens the measurement window.** Shipping is unconstrained — coordinated changes and full facelifts are fine; what's constrained is what we **claim**. Causal proof is visual-only: a PPO test measures a whole creative **bundle** against a live control, so a facelift is provable as a bundle, while metadata stays **correlational however it's sequenced** (industry-estimated ~4-week reindex; Apple publishes no duration). The baseline pins at **go-live**, not submit; when several changes share one version they share one window, so attribution is **bundle-level and flagged mixed-authorship**, never per-change causation. So we bundle by coherent theme, report directional attribution honestly, and never run a metadata change that pollutes a live PPO test. A rejected or rolled-back change reopens the ledger entry cleanly; it never corrupts the measurement thread.
- **Rollback is a forward move, not an undo.** There is no atomic revert: undoing a gated change (title/subtitle/keywords) is **another version submission + review**, which restarts the reindex window — recovery is slow even though the submit is fast. Promotional text is the exception (instant, no review, non-indexed). Harm can't be *proven* mid-window, so the stop-loss is an explicit **risk-managed call on a correlational signal, not a proof** — and it is defined, not vibes:
  - **Metric:** median organic rank of the **defended set** (the top terms the listing already ranked for pre-change), tracked daily.
  - **Noise band:** reuse P3's documented rank noise band — day-to-day movement inside that band is ignored.
  - **Trigger:** defended-set median falls **> N positions beyond the noise band** *and* holds for **≥ M consecutive days** (default chosen N = 5, M = 5 — override before P8), read off the **early reindex signal** (~1–2 weeks) rather than the full window.
  - **Cost of acting:** a revert restarts the reindex clock, so a false positive is expensive — which is *why* the dual threshold (magnitude **and** persistence) exists, to filter a one-day blip. The operator confirms the revert; the agent never auto-reverts a gated field. Revert composes the **last good listing snapshot**, not a hand-rebuild.

**The hard part**

**App Review is asynchronous, slow, and opaque.** You submit, you may wait a day, and you might get a terse rejection with no machine-readable cause. The hard part is a durable state machine that survives that latency without losing the thread — tracking every in-flight change through review, mapping a rejection back to the exact recommendation and ledger entry that motivated it, and keeping the measurement window honest when a change is rejected, amended, and resubmitted. Get this wrong and the system either spams App Review or loses track of what it actually changed.

**What we show**

A recommendation proposed → approved by a human → submitted to App Store Connect via the API → tracked through review to live (measurement window opens) **or** returned rejected with the reason surfaced and the ledger entry reopened — alongside a PPO experiment launched through the API with no review required at all.

---

## ★ The Always-On Advisor — the North Star · → 10K+ users

The destination, and the bar everything was built to clear: a system that doesn't just advise but can **prove it helped** — and that puts the decisions which need a human front and centre.

**What it adds**

- **The daily digest.** In priority order: decisions that need a human first, then experiments that resolved, then market and anomaly alerts (rank drops, competitor moves, rating shifts), then the next recommended move. No item without its evidence and a link back to the ledger.
- **Provable visual wins.** Image analysis generates variant hypotheses; the Apple Product Page Optimization experiments launched in Phase 8 — real, concurrent A/B tests — supply the proof. This is the one place the system can say "we changed X and it **caused** +Y% conversion" and mean it.
- **Honest about underpowered apps.** A true A/B test needs traffic — Apple declares a treatment "performing better/worse" only at **≥ 90% confidence**, and recommends waiting for that before applying; a test can run up to **90 days** ([Apple — View PPO results](https://developer.apple.com/help/app-store-connect/view-app-analytics/view-product-page-optimization-results/), [Overview of PPO](https://developer.apple.com/help/app-store-connect/create-product-page-optimization-tests/overview-of-product-page-optimization/)). A low-traffic app's experiment may never reach that bar, so we **detect an underpowered test and report "inconclusive,"** never fake significance. The promise scales with the app, and we say so.
- **Agency portfolio.** Every app's ASO health, in-flight experiments, and pending human decisions in one view, sortable by what needs attention.
- **The system measures itself.** Of the recommendations applied, what fraction were measured — and of those, what fraction improved the target metric — reported as two honest numbers: a proven-win rate on visual experiments (A/B-backed) and a directional-improvement rate on metadata (correlational). A system that can't report this is opining, not optimising.
- **Run on rails.** SLOs — the digest delivered by a target time each day, freshness within ASC's ~2-day bound — tracked and alerted.

This is the line the whole plan was drawn toward: **"we recommended X, and it measurably worked."** Every earlier phase exists to make that sentence honest — the ledger to remember it, the connection to measure it, the scale to deliver it to everyone.

---

## The principle, and what we'll need

One line runs through every phase: **a plain recommendation we can prove beats a beautiful one we can't.** We lead with what's measurable, label what's only correlational, and prefer "we couldn't observe this" over a confident guess. The same rule covers the empty cases — **no reviews, no real competitors, an app pulled or unavailable in a storefront**: we report insufficient data and degrade the audit honestly, never fabricate output to fill the gap.

**Scope is iOS / App Store, end to end.** Android / Google Play is a **deliberate deferral**, not an oversight — every load-bearing surface here is Apple-specific (iTunes, review RSS, Search Ads popularity, App Store Connect, PPO), and Play needs its own data and proof stack (different metadata model, separate Play Console APIs, no PPO equivalent). It slots in later behind the same per-source seam, demand-gated — a future *source*, not a re-platform.

**External services & tooling — what we need, and when**

Naming the dependencies up front, by phase. Most of the beta runs on free Apple endpoints; paid data and scale infrastructure arrive only when a phase needs them.

| Data & API access | For | When |
|---|---|---|
| iTunes Lookup / Search / Review RSS (free) | core metadata, competitors, reviews | Beta |
| Crawler w/ quota (Firecrawl) | landing-page fetch, subtitle/promo, footprint pages | Beta |
| Web search / research (Exa or Tavily) | identity external-corroboration + footprint | Beta |
| Vision-capable LLM (Gemini or Claude) | icon / screenshot analysis | P2 |
| Base text LLM (paid Gemini — cheap Flash → capable tier at scale) | scoring / judgement (same Gemini can serve vision) | Beta → P7 |
| Apple Search Ads account + API (OAuth2 client-credentials) | keyword popularity (5–100 score) | P3 |
| Paid ASO data — a bake-off (AppTweak / AppFigures / AppKittie; most ship MCPs) | volume, rank, competitor keywords, reviews, revenue | P3 — **optional, behind the seam** |
| App Store Connect API — read (JWT/ES256 .p8 key + Analytics Reports API) | the real funnel / measurement | P7 |
| App Store Connect API — write scopes | applying changes (own the client for production) | P8 |

| Infrastructure (provision at scale) | For | When |
|---|---|---|
| LibSQL → Postgres | persistent store (beta → shared) | Beta → P6 |
| Redis / shared limiter | cross-instance rate limit + tally | P6 |
| Durable job queue | scheduled + horizontal jobs | P6 |
| Observability (logs / traces / metrics) | production monitoring | P6 |
| Secret store / vault (encrypted-at-rest) | ASC / Apple-Ads credentials | P6 / P7 |
| Digest delivery (email / Slack / push) | the daily digest | North Star |

**On MCPs:** every service above can be a plain API client; an MCP is just an optional accelerator that plugs into Mastra natively. **AppKittie's MCP is one option among several, never a requirement** — any paid provider sits behind the one-swappable-client-per-source seam (its schema never touches the domain model), and we run as few as possible (the crawler is already in the stack; one web-search MCP; one P3 data provider; optionally an App Store Connect MCP to prototype P7).

---

<a id="build-appendix"></a>

## Build Appendix — the artifacts an engineer builds against

The body above is the *plan*; this appendix is the *contract*. It pins the data model, the seam interfaces, the two algorithms the body calls "the hard part," the evidence type, the identity thresholds, per-phase acceptance criteria, and the spec→code map. Beta-critical items are concrete; later-phase items define the seam and defer the fill-in.

### A. Data model (beta — LibSQL/SQLite flavour, portable to Postgres)

Keys are `(app_id, country)` throughout — `app_id` is the iTunes track id, `country` the storefront. All timestamps UTC ISO-8601. `provenance` is one of `observed | observed_from_cache | inferred | unavailable`. **All our tables are namespaced `aso_`** — they share the LibSQL/Postgres database with Mastra's own storage tables (workflow state, agent memory), so the prefix prevents collisions and marks ownership.

```
aso_listing_snapshots
  id              TEXT PK            -- ulid
  app_id          TEXT NOT NULL
  country         TEXT NOT NULL
  fetched_at      TEXT NOT NULL      -- when the listing was observed
  listing_json    TEXT NOT NULL      -- the full normalised AppListing (domain/listing.ts)
  signals_json    TEXT NOT NULL      -- deterministic signals (scoring/signals.ts)
  report_json     TEXT NOT NULL      -- the assembled AuditReport (domain/audit.ts)
  rubric_version  TEXT NOT NULL      -- hash of RUBRIC weights at scoring time
  prompt_hash     TEXT NOT NULL      -- hash of the scoring prompt
  model_id        TEXT NOT NULL      -- e.g. gemini-2.x
  INDEX (app_id, country, fetched_at DESC)

aso_recommendations                  -- the suggestion ledger
  id              TEXT PK            -- ulid
  app_id          TEXT NOT NULL
  country         TEXT NOT NULL
  rec_key         TEXT NOT NULL      -- hash(dimension,intent,target_field,value_key); see §C
  value_key       TEXT NOT NULL      -- normalized candidate (keyword/theme/review id); '' for single-instance intents
  taxonomy_version TEXT              -- complaint-theme taxonomy version, a hand-bumped semver string e.g. 'theme-taxonomy@1' (fix_complaint_theme only); traceability, NOT folded into rec_key
  dimension       TEXT NOT NULL      -- DimensionId from the rubric
  intent          TEXT NOT NULL      -- IntentTag enum (see §C)
  target_field    TEXT               -- e.g. 'subtitle' | 'icon' | null
  title           TEXT NOT NULL
  body            TEXT NOT NULL
  before_text     TEXT               -- for metadata edits
  after_text      TEXT
  evidence_json   TEXT NOT NULL      -- EvidenceRef[] (see §D)
  status          TEXT NOT NULL      -- proposed | applied | dismissed | superseded
  superseded_by   TEXT               -- nullable, self-FK aso_recommendations.id; set when a taxonomy-bump remap supersedes this rec (§C); deferred-use, P8/6b+
  first_seen_at   TEXT NOT NULL
  last_seen_at    TEXT NOT NULL
  applied_at      TEXT               -- set when applied-detection fires
  proof_regime    TEXT NOT NULL      -- ppo_causal | funnel_asc | correlational | observable_now
  UNIQUE (app_id, country, rec_key)  -- one live row per logical recommendation

aso_identity_versions                -- append-only; ID-lite writes first, ID-full augments
  id              TEXT PK
  app_id          TEXT NOT NULL
  country         TEXT NOT NULL
  version         INTEGER NOT NULL   -- monotonic per (app_id,country)
  stage           TEXT NOT NULL      -- 'lite' | 'full'
  category        TEXT NOT NULL      -- citable category string
  category_band   TEXT NOT NULL      -- high | medium | low
  niche           TEXT
  niche_band      TEXT
  audience_json   TEXT               -- ID-full only
  tally_json      TEXT NOT NULL      -- per-signal-family: value, source_tier, fetched_at
  source          TEXT NOT NULL      -- resolved | human_confirmed
  created_at      TEXT NOT NULL
  INDEX (app_id, country, version DESC)

aso_competitors
  id              TEXT PK
  identity_id     TEXT NOT NULL      -- FK aso_identity_versions.id
  competitor_app_id TEXT NOT NULL
  basis           TEXT NOT NULL      -- function | category | human
  -- "rejected" is NOT stored here; it is resolved against the app-scoped
  -- tombstone set below, so it survives identity-version bumps.

aso_competitor_tombstones            -- app-scoped, version-independent
  app_id          TEXT NOT NULL
  country         TEXT NOT NULL
  competitor_app_id TEXT NOT NULL
  rejected_at     TEXT NOT NULL
  PRIMARY KEY (app_id, country, competitor_app_id)   -- a human-rejected peer, never re-surfaced across versions

aso_rec_occurrences                  -- per-audit presence, for belief accumulation
  rec_id          TEXT NOT NULL      -- FK aso_recommendations.id
  snapshot_id     TEXT NOT NULL      -- FK aso_listing_snapshots.id (the audit it appeared in)
  was_dismissed   INTEGER DEFAULT 0
  PRIMARY KEY (rec_id, snapshot_id)  -- "raised in 3 of last 4, never dismissed" needs per-audit rows, not two timestamps
```

A new identity version's competitor set is filtered through `aso_competitor_tombstones` at read time, so a rebrand inherits prior rejections by construction — no carry-forward step to forget.

`aso_measurement_windows` and `aso_submissions` (P7/P8) are deferred but **seam-reserved**: a window has `(rec_key, opened_at_golive, baseline_json, regime, verdict)`; a submission has `(version_id, idempotency_key, state, rec_keys[], resolution_text)`. Defined when those phases land, not before.

### B. Seam interface contracts (some already exist in code — *reference, don't rebuild*)

```ts
// EXISTS: domain/result.ts — the error contract for everything below
type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

// EXISTS: sources/index.ts — one provider per source already follows this shape
interface SourceProvider<TQuery, TData> {
  readonly id: string;                              // 'itunes' | 'firecrawl' | ...
  fetch(q: TQuery): Promise<Result<TData, SourceError>>;
}

// EXISTS: llm/provider.ts — keep; resolve the Ollama-vs-Gemini default (see §G)
interface LlmProvider { /* generate, reachable, endpoint, modelId */ }

// NEW (P1): the storage seam the "config change, not migration" claim rests on.
interface StorageClient {
  putSnapshot(s: ListingSnapshot): Promise<Result<void>>;
  latestSnapshot(appId: string, country: string): Promise<Result<ListingSnapshot | null>>;
  upsertRecommendation(r: Recommendation): Promise<Result<void>>;   // dedup on rec_key
  recordOccurrence(recId: string, snapshotId: string, wasDismissed: boolean): Promise<Result<void>>;  // writes aso_rec_occurrences (the belief-accumulation write path)
  ledger(appId: string, country: string): Promise<Result<Recommendation[]>>;
  appendIdentity(v: IdentityVersion): Promise<Result<void>>;
  latestIdentity(appId: string, country: string): Promise<Result<IdentityVersion | null>>;
  tombstoneCompetitor(appId: string, country: string, competitorAppId: string): Promise<Result<void>>;
  tombstones(appId: string, country: string): Promise<Result<Set<string>>>;  // app-scoped, version-independent
}
// Forbidden to leak through: no provider/vendor schema and no SQL dialect in the
// return types — only domain types. This is what makes LibSQL↔Postgres a config swap.

// NEW (P5): cache + governor, keyed by ENTITY not user (the multi-tenant seam)
interface Cache {
  get<T>(key: EntityKey): Promise<{ value: T; fetchedAt: string } | null>; // key = `${kind}:${id}`
  set<T>(key: EntityKey, value: T, ttlSeconds: number): Promise<void>;
}
interface Governor {                                  // in-process singleton in beta
  preflight(call: MeteredCall): Result<void, 'count_cap' | 'wallclock_cap'>;
  recordEstimate(tokens: number, dollars: number): void;   // post-hoc in beta
}
```

### C. Recommendation identity + dedup (P1's "hard part"), and the intent taxonomy

**`rec_key` = stable hash of `(dimension, intent, target_field, value_key)`** — *not* the wording. `value_key` is the **normalized candidate value** that distinguishes instances of a multi-instance intent — the keyword string for `add_keyword`/`remove_wasted_term`, a **canonical complaint-theme id** for `fix_complaint_theme` (see below), the **review id** for `respond_to_reviews` (Apple's stable RSS review id) — and is **empty for single-instance intents** (`add_preview_video`, `enable_promo_text`, `rebalance_title_subtitle`, `reposition_identity`, `improve_icon_legibility`). Without `value_key`, two *different* keyword suggestions for the subtitle would hash identically and the second would silently upsert over the first — the exact collision P1 exists to prevent. Two runs that produce the **same** suggestion (same `value_key`) phrased differently still map to one `rec_key`, so re-suggestion is an `upsert` (bump `last_seen_at`), not a duplicate row. The **contradiction guard** is then a pure lookup: a new rec whose `rec_key` matches a `dismissed`/opposite row is flagged before emit.

**`value_key` normalization is pinned:** casefold + Unicode NFC + trim, **plus the linter's own plural rule (s/es)** — so **plural variants collapse to one `value_key`**. Apple indexes singular and plural together, so "add *tracker*" and "add *trackers*" are the *same* opportunity and must not re-litigate as two recs; using the **same plural rule the P3 linter uses** means dedup and the linter's plural-redundant flag never disagree. **No full stemming** (it would over-collapse e.g. "analytic"/"analytics").

**The one intent without a free stable id is `fix_complaint_theme`.** A keyword string and a review id are stable across audits; a *theme* is not — P4 re-clusters a **different review sample each run**, so a naive "theme id" would drift and a dismissed complaint could resurface under a new key (the exact P1 collision, reopened). So `fix_complaint_theme`'s `value_key` hashes a **canonical complaint-theme id from a fixed v1 taxonomy** — **enumerated, not just named**, the same way `IntentTag` is:

`crash_stability | login_auth | pricing_subscription | ads_intrusive | performance_speed | battery_resource | data_loss_sync | ui_ux_confusion | onboarding | notifications | privacy_permissions | customer_support | device_compat | content_quality | other`

The classifier maps each extracted theme to one of these, **riding the existing P4 theme-extraction LLM pass** (no extra call). The **canonical path is the normal case**; only a theme that lands in `other` falls back to an **embedding-similarity match against prior audits' `other`-bucket theme texts** (Gemini embedding model, **cosine ≥ 0.85**, tuned on the golden set), and that match is **labelled approximate** — never presented as as-solid-as a canonical id. This **promotes P4's "shared theme taxonomy" from a secondary uplift to a beta-critical dependency** for this one intent. Growing the taxonomy is a **versioned change** — `taxonomy_version` is a **hand-bumped semver string** (`theme-taxonomy@1` → `@2`), *not* a hash like `rubric_version` (the taxonomy is a rare, human-curated list, so a readable bump fits how it actually changes) — so `other` stays small over time rather than becoming the default path. **A bump that *remaps* a theme** (e.g. splitting `crash_stability` into `crash_on_launch` + `crash_on_action`) marks the old rec **`superseded`** and sets its **`superseded_by`** (§A) to the new rec's id — extending that status's trigger from listing-change to taxonomy-change — so an ongoing complaint migrates rather than stranding silently. *(Deferred by design: no bump occurs before ~6b; the rule is decided now, implemented at the first bump.)*

**Feature requests are disjoint** — a "users keep asking for X" review routes to P4's **human hand-off**, *not* to a `fix_complaint_theme` recommendation (you can't fix a missing feature with metadata). It carries no `value_key`, never enters the ledger, and is therefore deliberately **not** a complaint-theme bucket — keeping P4's two routing paths (actionable complaint → ledgered rec; feature request → human queue) from ever claiming the same review.

**Beta calibration:** the `cosine ≥ 0.85` threshold here (and §E's confidence bands) ship as **fixed engineering defaults**, sanity-checked against the §F fixtures (which exist at beta). The **6b golden set** is the formal validation step and may **retune** them — but a retune is a **versioned change** (hence `taxonomy_version`), never silent drift, and it does **not** reclassify historical rows: existing recs keep the threshold/taxonomy version they were computed under.

**Applied-detection** sets `status=applied, applied_at` when the new listing snapshot satisfies the rec's `after_text`/target-field change — a **match, not a causal claim** (we don't assert we caused the edit; causation is the P7 window's job). A rec that no longer applies because the listing moved past it becomes `superseded`, never silently dropped.

**`IntentTag` — the fixed taxonomy** (closed enum; belief-accumulation counts against it):
`add_keyword | remove_wasted_term | rebalance_title_subtitle | reposition_identity | improve_icon_legibility | reorder_screenshots | add_preview_video | localise_storefront | respond_to_reviews | fix_complaint_theme | improve_description_hook | enable_promo_text`.

### D. Evidence-trail type (the clickable chip)

```ts
type EvidenceRef =
  | { kind: 'signal';        signalId: string; snapshotId: string }      // a deterministic signal
  | { kind: 'listing_field'; field: string;    snapshotId: string }      // e.g. 'subtitle'
  | { kind: 'review';        reviewId: string; snapshotId: string }      // a specific review
  | { kind: 'competitor';    competitorAppId: string; field: string }
  | { kind: 'unavailable';   reason: 'not_observed' | 'capped' | 'script_unsupported' };
```
Every claim carries ≥1 `EvidenceRef`, frozen into the snapshot — so a chip resolves deterministically into *that date's* source data and can never be back-dated or mis-pointed. `unavailable` is a first-class value, never an empty string.

**On upsert (a rec re-raised in a later audit):** `aso_recommendations.evidence_json` updates to point at the **most recent snapshot that still supports the rec**, so the chip a user clicks always resolves to currently-true evidence. The full per-audit history is **reconstructable** from `aso_rec_occurrences`: it stores the `snapshot_id` the rec appeared in, and that date's source data lives immutably in `aso_listing_snapshots`, so the chip's *then*-target is re-derivable from the snapshot (not stored verbatim per occurrence). The audit trail stays immutable even though the live chip moves forward.

### E. ID confidence — weighted tally → band (resolves the "counted vs weighted" gap)

Signal families score by tier: **observed-on-store = 2, fetched-and-cited = 2, cross-store = 1, review-inferred = 1, world-knowledge = 0** (prior only; never counts toward the tally alone). Let `S` = summed weight of *agreeing* families.

| Band | Rule (illustrative defaults — tune on the golden set) |
|---|---|
| **high** | `S ≥ 4` from **≥2 distinct families**, **and** no cross-domain divergence, **and** at least one tier-2 family. The **cap is applied after the tally**: if every agreeing family is **on-store only** (developer, bundle-id, permissions, IAPs), the result is **capped at medium** regardless of `S` — so two on-store tier-2 families (S = 4) resolve to medium, not high, because an app's own first-party signals aren't independent corroboration. |
| **medium** | `S = 2–3`, or high-evidence but with a within-domain divergence flag. |
| **low / escalate** | `S ≤ 1`, **or** two tier-2 families in **cross-domain** conflict (conflict→low, never averaged), **or** a high observed function over an inferred-only niche. |

Escalation is asymmetric: a low *niche* under a high *category* adds a flag, never blocks. `human_confirmed` is its own categorical tier, above all of these, and never expressed as a percentage.

**Beta calibration (same rule as §C):** these bands ship as **fixed engineering defaults** validated against the §F fixtures (Rivian / TikTok / Spotify), not against a golden set that doesn't exist yet. The **6b golden set** is the formal retuning step — a **versioned change**, no silent drift, and it never reclassifies historical identity rows (each keeps the band logic it was computed under).

### F. Per-phase acceptance criteria (Definition of Done — testable)

- **ID-lite:** given a fixture listing, resolver returns category + band + a tally citing each family to its source; Rivian fixture → category Travel-vs-vehicle **cross-domain → escalate**; TikTok/Spotify fixtures → **zero asks**; on-store-only fixture → band **≤ medium**. Identity row written to `aso_identity_versions` (stage=`lite`).
- **P1:** audit the same app twice → second run reads the first; a re-raised suggestion yields **no duplicate ledger row**, **yet two distinct `add_keyword` recs for the same field survive as two rows** (the `value_key` discriminator works — the test asserts *both* directions, so a key-collision bug can't pass); contradiction guard fires on a reversed rec; rubric-weight replay recomputes a stored draft's score with **zero LLM calls** (assert call count = 0).
- **P2 / ID-full:** each image gets a confidence-labelled critique; ID-full augments the identity row (stage=`full`) **without changing** ID-lite's deterministic fields; pHash distance emitted as `observed`, confusability as `inferred`.
- **P3:** linter is deterministic (same input → byte-identical output, no model call); competitor keyword findings labelled `inferred`; non-Latin storefront → mechanics suppressed + labelled, not guessed.
- **P4:** review fetch paginates to the configured cap; per-version delta only emitted when both versions clear the min-sample threshold, else "insufficient sample." A **dismissed complaint theme does not resurface** across two audits run on different review samples — for a **canonical-taxonomy** theme the id keeps `value_key` stable; for an **`other`-bucket** theme, two differently-worded-but-equivalent complaints **collapse to one `value_key` via the embedding fallback** (cosine ≥ threshold) while two genuinely distinct complaints stay separate. The test re-runs with a perturbed sample and asserts both paths.
- **P5:** re-audit hits cache (0 upstream calls, provenance `observed_from_cache`); re-entrant loop killed within ~2s; pacer spaces iTunes calls ≥3.5s and honours injected `Retry-After`; a single deep audit stays under the 5-min cap.
- **6a:** two tenants fully isolated (cross-tenant read returns nothing); two instances share one limiter (aggregate iTunes rate ≤ ceiling); LibSQL→Postgres swap passes the **same** StorageClient test suite.
- **6b:** audit survives a worker kill (idempotent retry, no double-file); golden-set regression catches a deliberately-degraded prompt.
- **P7:** funnel baseline pinned at go-live read from ASC version status; metadata verdicts labelled `correlational`.
- **P8:** gated bundle = one version, one idempotency key; rejection maps back to the exact `rec_key`; stop-loss fires only on (magnitude **and** persistence) past the noise band.
- **North Star:** self-measurement reports two separate numbers (A/B-proven-win rate vs. correlational-improvement rate); underpowered PPO reported `inconclusive`.

### G. Spec → code map, and the reconciliations the build must make

| Phase | Adds | Modifies (existing) |
|---|---|---|
| ID-lite | `mastra/tools/resolve-identity.ts`, `domain/identity.ts` | `tools/identify-app.ts` (feed signals), `workflows/audit-workflow.ts` (resolve before score) |
| P1 | `memory/` (StorageClient + schema), `memory/dedup.ts` | `audit-workflow.ts` (read history pre-score), `scoring/score.ts` (inject history) |
| P2 | `vision/` pass | `scoring/signals.ts` (icon/screenshot facts), `rubric.ts` |
| P3 | `keywords/` (linter + ASA client) | `rubric.ts` (keyword checks) |
| P4 | `reviews/themes.ts` | `sources/itunes.ts` (RSS pagination 25→~500) |
| P5 | `cost/{cache,governor,pacer}.ts` | `sources/http.ts` (wrap), `llm/*` (wrap) |

**Required reconciliations (do these as part of the relevant phase — they are live spec↔code contradictions today):**
1. **`scoring/rubric.ts:83`** asserts *"Readable on-image text (Apple OCR-indexes it)"* — change to match v1.1.1: OCR is **contested**; on-image text is a conversion lever, keyword value is a hypothesis. (Do at P2.)
2. **Ollama vs Gemini:** `audit-workflow.ts` error text and `llm/ollama.ts` make Ollama the implied default; the spec says **paid Gemini**. Decide: Gemini default with Ollama as a clearly-labelled dev fallback (keeps a fallback provider — see open decision), or remove Ollama. Update the error message either way. (Do at the start of the build.)

### H. Open decisions — defaults chosen, override any before the relevant phase

| # | Decision | Default chosen |
|---|---|---|
| 1 | ID one phase or two? | **Two — ID-lite (beta) + ID-full (P2).** |
| 2 | Loop-kill ceiling / dollar-cap default | **~2,000 metered calls/hr (above the ~600–800 busy-hour legit peak); $5/day estimate.** |
| 3 | Beta dollar cap enforced or advisory? | **Advisory/post-hoc;** count-kill is enforced; tokens wired at P7. |
| 4 | P6 one phase or split? | **Split 6a / 6b.** |
| 5 | P8 stop-loss threshold | **Defended-set median > 5 positions beyond noise, held ≥5 days.** |
| 6 | AppKittie competitor egress | **Query by public app id only, never customer-identifying batches; prefer non-competitor for load-bearing queries.** |
| 7 | Keep Ollama as LLM fallback? | **Keep as labelled dev fallback** (avoids a single-provider SPOF); Gemini is the default. |

---

*ASO Agent · phased build plan v1.3.1 · specification.html (human) + specification.md (LLM/agent)*
