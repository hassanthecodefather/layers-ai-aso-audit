# Work Report — Phase 0 & Phase A

**Project:** ASO Audit Agent (Mastra + Gemini)
**Branch:** `worktree-aso-phase-0-and-a`
**Spec:** `specification.md` / `specification.html` v1.3.1 · **Plan:** `IMPLEMENTATION_PLAN.md` · **Dashboard:** `STATUS.md`
**Status:** Phase 0 ✅ · Phase A (A0–A6) ✅ · **186 hermetic tests pass**, 2 live smokes skipped by default (key-gated).

---

## 1. Executive summary

Phase 0 turned the codebase Gemini-only and stood up a migration runner. Phase A delivered the product's foundation: **ID-lite identity resolution** (grounding *what an app really is* before diagnosing it) and **P1 persistent memory** (a deduped recommendation ledger that reads its own past output), plus **A6 score determinism** — a substantial late addition that made the per-dimension scores reproducible after live testing exposed a 16-point run-to-run swing.

The throughline of the whole phase is one principle, applied repeatedly: **deterministic signals decided in code; the LLM confined to judgment, and never trusted with anything that must be stable.** Most issues we hit were a violation of that principle somewhere; most fixes were moving a decision out of the model and into code.

---

## 2. Phase 0 — Groundwork & reconciliation ✅

| Task | What we did |
|---|---|
| **0.1 Remove Ollama (Gemini-only)** | Deleted the Ollama provider, dropped its branch from the `llm/` switch, and **flipped the defaults** (`LLM_PROVIDER`, `DEFAULT_MODEL`) to Google — without this, `getLlmProvider()` resolved to a deleted provider and the app wouldn't boot. Rewrote the workflow's model-unreachable error text to reference Gemini. |
| **0.2 Gemini + pinned model + pinned temperature** | Confirmed `llm/google.ts` reads the key, `reachable()`/`modelId`/`endpoint` work; pinned the beta model `gemini-2.5-flash`; **pinned scoring temperature to 0** at the generate call (`modelSettings: { temperature: 0 }`). |
| **0.3 Migration runner** | `memory/migrate.ts` — idempotent (`CREATE TABLE IF NOT EXISTS`) creator for the `aso_*` namespace, run before the app touches storage. |

---

## 3. Phase A — ID-lite + P1 Persistent Memory ✅

ID-lite and P1's storage shipped as **one build unit** (ID-lite has no standalone existence before the storage seam).

### A0 · Fixtures
Froze real iTunes Lookup + crawler + review responses for **Rivian** (cross-domain → escalate), **TikTok** & **Spotify** (zero asks), an **on-store-only** app (≤ medium), and a competitor set. These are the deterministic inputs the §F acceptance tests run against.

### A1 · Storage seam + schema
- `memory/storage-client.ts` — the `StorageClient` interface; `libsql-storage-client.ts` — a LibSQL implementation over raw `@libsql/client`, pointed at the same DB Mastra uses (`file:./aso-audit.db`) so the `aso_*` tables sit beside Mastra's own.
- **Tables:** `aso_listing_snapshots`, `aso_recommendations`, `aso_identity_versions`, `aso_competitors`, `aso_competitor_tombstones`, `aso_rec_occurrences` (+ supporting indexes).
- **Contract guard:** only domain types cross the interface — no SQL dialect leaks — which is what makes the future Postgres swap a config change. A single engine-agnostic **conformance suite** (`storage-client.conformance.ts`) is the same suite Postgres must later pass.

### A2 · ID-lite resolver
The deterministic identity engine (`identity/{signals,domains,resolve}.ts` + `mastra/tools/resolve-identity.ts`).
- **Signals that fire today:** developer, bundle-id reverse-DNS org, marketing-domain match, review vocabulary.
- **Confidence model (spec §E):** a *weighted* tally of agreeing signal families — `observed_on_store`=2, `fetched_and_cited`=2, `cross_store`=1, `review_inferred`=1, `world_knowledge`=0 — mapped to a band (high / medium / low), with an **on-store-only cap at medium** (an app's own first-party data isn't independent corroboration).
- **Two axes:** category + niche; niche is inferred-only at ID-lite (no vision) so it's medium-at-best.
- **The escalation gate:** `divergenceBetween(storeCategory, functionCategory)` maps each to a coarse domain; different domains → `cross_domain` → band collapses to **low** → **escalate to a human**, regardless of how many signals agree. (This is why Rivian — all four signals agreeing, but "Travel" vs "EV companion" — still escalates.)
- **The one LLM call:** an `identity-classifier` agent turns the deterministic fact sheet into `{functionCategory, functionNiche, functionTerms}` at temp 0; schema-validated, with a safe `UNKNOWN` fallback. The model *proposes* the function; **code corroborates and gates it.**
- **Web-search corroboration tier:** built behind a seam, stubbed (`NoopWebSearch` → `searched-and-empty`) until a key lands.

### A3 · Workflow wiring + dedup (the "hard part")
- Resolve identity **before** scoring; inject the **identity fact sheet** into the scoring prompt (grounds the model). History is reconciled **in code after generation**, not injected into the prompt (see Issue 3).
- **Dedup:** `rec_key = hash(dimension, intent, target_field, value_key)`, upsert on `rec_key`. `value_key` is computed in code from a **typed referent** the model emits, never from its prose.

### A4 · P1 uplifts
Applied-detection (status = *match, not cause*), change-diff, contradiction guard, immutable snapshots + zero-LLM rubric replay, and a clickable typed evidence trail (`EvidenceRef`) frozen into each snapshot; intermittent raised→dismissed→raised history reconstructable from `aso_rec_occurrences`.

### A5 · Human-escalation gate + human-confirmed override
The widened `confirm-app` suspend step surfaces the resolved identity for confirm / correct / pick; the decision is read post-resume and applied. A `human_confirmed` identity is sticky, recorded as a categorical tier (never a fake 100 %), respected on future audits, and re-asked only when the signals it rested on materially change *and* the answer flips. A confirmed identity **permits** the identity-rewriting recommendations that an unconfirmed one suppresses.

### A6 · Score determinism (late addition — see Issue 5)
Pushed the existing code/LLM split down from the headline total to **each dimension**:
- **Code-derived confidence** for all 10 dimensions (the model can no longer flip a dimension `unavailable` and silently re-weight the score).
- **Code-scored deterministic dimensions:** screenshots (slots-used-of-10), preview-video (present→8/absent→0), ratings (`avg/5·10` + ±1 trend nudge).
- **Coarse-ordinal for mixed dimensions** (title/subtitle): utilisation floor then snap to {0,5,10}.
- **Reuse, don't recompute:** whole-snapshot byte-identical ⇒ reuse the report with zero LLM; otherwise a per-dimension splice reuses any dimension whose inputs are unchanged.
- **Identity resolution pinned to temp 0** too; **prompt echoes the computed scores** so the model's narrative matches the displayed number.

---

## 4. Issues faced & solutions

The most valuable part of the phase — each was surfaced by live testing or review, diagnosed to a root cause, and fixed in code.

**1. `rec_key` collision from prose-derived `value_key`.**
*Symptom:* re-auditing Rivian created duplicate ledger rows for the same suggestion. *Cause:* `value_key` was derived from the model's free-text `after`/`title`, which Gemini reworded run-to-run → different hash → new row. *Fix:* the model emits a **typed referent** (keyword / country / theme / reviewId / none); `value_key` is computed in code from the referent, never from prose. A *reworded* re-raise now collapses to one row; two genuinely distinct recs still survive as two.

**2. The `other`-bucket trap (caught in review).**
Returning the literal `'other'` as a theme `value_key` would have merged every uncategorised complaint into one row. *Fix:* the `theme` referent carries `{bucket, text}`, and an embedding fallback (`resolveThemeKey`, cosine ≥ 0.85) is used **only** for `other` — deferred to Phase D where review themes actually fan out.

**3. Ledger-injection feedback loop.**
*Symptom:* the recommendation set drifted every run; the ledger grew without bound. *Cause:* injecting the prior-recommendation ledger into the generation prompt made the model deliberately *diversify away* from past recs. *Fix:* **stateless generation** — generation is a pure function of (listing + identity); the ledger is read **after**, in the code reconciliation layer. (The `buildPriorContext` docstring was later corrected to match this.)

**4. Structural-gate non-compliance + dimension flicker.**
*Symptom:* gated recs (e.g. `enable_promo_text`) appeared when they shouldn't; a rec's `dimension` flickered run-to-run. *Cause:* a rec's *existence* and its `dimension` were left to model text. *Fix:* structural existence gates and `dimension` are **deterministic in code** (`candidates.ts`); the model ranks/phrases, it doesn't free-invent the rec set or any `rec_key` component.

**5. Score swing 46 → 30 at temperature 0 (the big one → A6).**
*Symptom:* two identical re-audits of an unchanged listing returned overall 46 then 30. *Investigation* ruled out the temperature flag (it *was* correctly wired). *Root cause was structural:* (a) the overall was a weighted mean of the model's **free 0-10 per-dimension scores** — even fact-based dimensions drifted; (b) the model-authored `confidence` controlled the normalization denominator, so one dimension flipping `inferred`↔`unavailable` re-weighted everything; (c) the schema-repair path re-sampled a fresh draft. *Fix:* the whole of **A6** — code-derive confidence, code-score deterministic dimensions, coarse-ordinal the mixed ones, and reuse unchanged dimensions/snapshots so the score-delta is attributable to the actual edit.

**6. Narrative ↔ score mismatch.**
*Symptom:* after A6, the model's findings said "7/10" while the card showed the code-computed 5. *Fix:* a `## Scoring constraints` block in the prompt tells the model the code-computed values and restricts title/subtitle to {0,5,10}, so its narrative matches the displayed number.

**7. Single-source-of-truth drift in the prompt echo.**
*Symptom (review):* the constraints block **re-implemented** the ratings/preview formulas. *Fix:* render those values from `codeScore(id, signals)` so the prompt can't drift from the code. (Residual: the floor *threshold* `20` is still duplicated — tracked, optional `coarseOrdinalFloor` helper.)

**8. Floor-case mismatch.**
*Symptom (review):* a short brand title floored to 0 by code still read "acceptable → 5" because the floor wasn't communicated. *Fix:* the prompt emits a forced `→ 0` bullet when `utilisation < 20%`, and subtitle's unobservable case is handled inline.

**9. Screenshot overcount corrupting the A6 score.**
*Symptom (review):* a "count CDN image URLs and `Math.max` with iTunes" fix would saturate the screenshots score at 10 for most apps — `mzstatic.com/image/thumb` URLs on the page include iPad shots, preview posters, and *related-app icons*, not just screenshots. *Fix:* source `slotsUsedOf10` from iTunes `screenshotUrls.length` (authoritative); the crawler count is a fallback **only** when iTunes returns 0. (Open: a regression test pinning that a larger crawler count can't raise the score.)

**10. Robustness fixes (review pass).** Dismissed recs no longer silently re-open on a reworded re-raise (referent stability makes dismissals sticky); the identity classifier **fails safe** on malformed JSON instead of throwing; the Mastra `getStepResult`-across-resume assumption A5 relies on is now guarded.

---

## 5. Architecture invariants established

- **No `rec_key` component (dimension / intent / target_field / value_key) and no rec's existence is free model text** — all deterministic or from a typed, schema-validated enum.
- **Recommendation generation is a pure function of (listing + identity);** history is reconciled in code, never injected into the generation prompt.
- **The model proposes; code disposes.** Identity: the model guesses the function category; code corroborates (tally) and gates (divergence → escalate). Scoring: the model judges; code computes confidence, the deterministic dimension scores, the quantization, and the 0-100 total.
- **Reuse, don't recompute.** Byte-identical identity-signals reuse the stored identity at zero LLM; byte-identical listing snapshots reuse the stored report; unchanged dimensions reuse their stored score.
- **Honesty discipline.** Every signal/score is labelled observed / inferred / unavailable truthfully; stubbed sources report `searched-and-empty`, never fabricated data; on-store-only confidence is capped; the system escalates on doubt rather than guessing.

---

## 6. Testing

- **186 hermetic tests pass** (no network, no key). Coverage: StorageClient conformance, §F ID-lite gates (Rivian→escalate, TikTok/Spotify→zero-asks, on-store-only→≤medium), §F P1 gates (typed-referent dedup incl. reworded re-raise, contradiction guard, zero-LLM rubric replay), human-confirm reuse/re-ask, the memory loop end-to-end, classifier fail-safe parsing, dismissal-is-honoured, the `getStepResult`-across-resume contract, and A6 score stability (code overrides win, single-field edit moves only that dimension, deterministic scores are pure functions of signals).
- **2 live smokes** (`audit-smoke`, `workflow-smoke`) — gated on a real Gemini key, skipped by default; exercise the real classifier + the full suspend→resume→report path.
- **Test doubles:** frozen input fixtures + a stub classifier injected via the `IdentityClassifier` seam, which lets tests assert **LLM call counts** (how the "zero LLM" replay assertion is even writable).

---

## 7. Known gaps, deviations & caveats (conscious, tracked)

**Deviations (by design):**
- Identity is resolved in the `identify-app` *step* from its existing iTunes fetch, not by modifying the `identify-app` *tool* (the §G "no re-fetch" intent holds).
- **Permission strings / IAP names / privacy labels** are modelled but report `not observed` — they're not in the iTunes Lookup response. They're corroboration, not load-bearing for the gates; wire via the crawler later.
- **Web-search (Exa/Tavily)** and **Apple Search Ads** are stubbed behind their seams (no keys yet) — drop-in, one file each, when keys land.

**A6 beta-calibration caveats (6b golden-set retune, spec §C/§E — not blockers):**
- Coarse-ordinal **boundary instability**: a model wavering 7↔8 flips 5↔10 on title's weight-20 dimension. Mitigation if it surfaces: hysteresis or 5 anchors.
- The **`utilisation < 20%` → 0 floor is harsh** — it zeroes the whole dimension on one of four checks (a short brand title scores 0).

**Open follow-ups (small, optional):**
- A `coarseOrdinalFloor(id, signals)` helper to fully single-source the floor threshold (currently duplicated in `coarseOrdinalScore` and `scoringConstraints`).
- A regression test pinning the screenshots iTunes-source fix (crawler count can't raise the score when iTunes is non-empty).

**Carried into Phase B (from the review pass):**
- Applied-detection only maps title/subtitle/description today (keywordField/icon/screenshots/reviews recs never flip to `applied`).
- A human-confirmed cross-domain identity still triggers the "do not rewrite positioning" prompt note (gate on `escalate`/`source`, not `divergence`).
- The identify-step LLM call has no `reachable()` guard (a down model surfaces as a 422).
- `buildAuditPrompt` is built twice per audit; `persistAudit` re-reads data already fetched.
- **B1 must supersede A6's screenshot/preview Phase-A placeholder scores** and upgrade their confidence `inferred → observed` once vision actually assesses quality.
- Reconciliation §G #1: reword `rubric.ts` line 83 (the OCR/keyword-indexing stance).

---

## 8. What's next

Phase A is complete and the foundation is stable. **Phase B** is P2 image analysis (Gemini vision over screenshots + icon) and ID-full (vision-grounded identity), which also discharges the screenshot/preview placeholder supersede and the §G #1 reconciliation. The single cheapest thing worth doing first is the **screenshots regression test** — it pins a fix that's already been gotten wrong once.

_Report generated 2026-06-27 · spec v1.3.1 · 186 hermetic tests green._
