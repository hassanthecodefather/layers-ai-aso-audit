# Take-home: ASO Audit Agent

Build a TypeScript chat app where the user pastes an Apple App Store URL — for example, https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580 — and gets back a useful ASO audit.

The flow we want:

1. User pastes the URL into the chat.
2. The agent fetches surface-level metadata for that listing (name, developer, icon, category, country) and confirms with the user: *"Is this the app you meant?"*
3. On confirmation, the agent runs the full ASO audit and presents the recommendations.

Keep the user informed while the audit is running, and present the recommendations in a way that's actually nice to look at.

We will run your repo against apps you haven't seen.

## Framework

[Mastra](https://mastra.ai). We want to see idiomatic use of agents, tools, workflows, and skills. The docs entry point is `https://mastra.ai/llms.txt`.

Everything else is your call.

## The audit

You don't need to be an ASO expert. Use this framework (refine it if you'd like) as the audit's instructions. It's adapted from the open-source [aso-skills](https://github.com/Eronred/aso-skills) project.

> **You are an expert in App Store Optimization with deep knowledge of Apple's ranking algorithms. Perform a comprehensive ASO health audit and produce a prioritized action plan.**
>
> Score the listing on each dimension below on a 0–10 scale. The weighted sum is the overall ASO Score out of 100.
>
> | Dimension | Weight | Key checks |
> |---|---|---|
> | **Title** (30 char limit) | 20% | Primary keyword present? Character utilization? Brand vs. keyword balance? Natural reading, not stuffed? |
> | **Subtitle** (30 char limit) | 15% | Distinct secondary keywords (not repeating title)? Benefit-driven? Full character utilization? |
> | **Keyword field** (100 char limit, iOS) | 15% | No duplicates with title/subtitle? Singular forms (Apple indexes both)? No spaces after commas? No wasted words ("app", category names, brand)? Full 100 chars used? |
> | **Description** | 10% | First 3 lines hook above the "more" cutoff? Features benefit-framed? Social proof? Clear CTA? Natural keyword integration? |
> | **Screenshots** | 15% | All 10 slots used? First 2–3 communicate value? Readable on-image text (Apple OCR-indexes it)? Cohesive design language? |
> | **App preview video** | 5% | Exists? Hook in first 3 seconds? 15–30 seconds? Works without sound? |
> | **Ratings & reviews** | 15% | Average rating? Recent trend? Themes in praise and complaints? Developer responds to negatives? |
> | **Icon** | 5% | Distinctive in search results? Clear at small sizes? Category-appropriate? Avoids unreadable text? |
> | **Conversion signals** | 5% | Promotional text used? "What's New" informative? In-App Events? Custom product pages? |
> | **Competitive position** | 5% | Keyword coverage vs. top 3 competitors in the same category? Visual style? Rating gap? |
>
> **Output format:**
> - **ASO Score Card** — per-dimension scores with progress bars and a single overall score out of 100.
> - **Quick Wins** — 3–5 changes implementable today, high impact.
> - **High-Impact Changes** — 3–5 changes requiring more effort.
> - **Strategic Recommendations** — 3–5 longer-term improvements.
> - **Competitor Comparison** — brief table comparing the app to top 3 competitors on key metrics.
>
> For each recommendation, cite the specific evidence (actual data point) and include before/after examples for any text-based change (title, subtitle, keyword field, description, screenshot captions). Be specific — "rewrite the title from 'X' to 'Y' because Z" beats "improve the title."

How you wire this into your agent is your call.

## What we'll judge

- It works end-to-end on URLs we pick, not just the Spotify example.
- The code reads as something a senior TypeScript engineer would ship.
- The decisions you made are deliberate, and that comes through in the work.

## Free-tier options if you want them

[Firecrawl](https://firecrawl.dev) for App Store scraping. [NVIDIA NIM](https://build.nvidia.com) for OpenAI-compatible LLM credits. Use whatever you prefer.

## Deliverable

**Private** GitHub repo — invite `@mikekhristo` as a collaborator. `npm install && npm run dev` works. `.env.example` is complete. README with setup and a short note on the decisions you made that we left to you.

Include a short screen-recorded video walking us through your build end-to-end — talk through what's happening as you demo it.

We don't care how long this takes. Use whatever tools you'd normally use.