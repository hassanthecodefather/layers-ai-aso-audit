# ASO Audit Agent

A conversational **App Store Optimization** auditor, built on
[Mastra](https://mastra.ai). Paste an Apple App Store URL into the chat; the
agent confirms which app you mean, then scores the listing across ten ASO
dimensions and returns a prioritised, evidence-backed action plan.

```
paste URL ─▶ confirm "is this the app?" ─▶ [yes] ─▶ audit ─▶ score card + recommendations
```

> **What was built, how it maps to the brief, and the engineering decisions:
> see [DESIGN.md](DESIGN.md).**

---

## Quick start

**Prerequisites:** Node ≥ 20.9, npm ≥ 10.

```bash
npm install
cp .env.example .env      # then set your LLM config — see below
npm run dev
```

This starts the Mastra server (`:4111`) and the web UI (`:5173`). Open
**http://localhost:5173** and paste an App Store URL.

## Configuration

The audit needs an OpenAI-compatible LLM. The default provider is **Ollama**,
hosted or local — set one of these in `.env`:

| Option | Setup | `.env` |
|---|---|---|
| **Ollama Cloud** *(recommended)* | Key from [ollama.com/settings/keys](https://ollama.com/settings/keys) | `LLM_BASE_URL=https://ollama.com/v1`<br>`LLM_MODEL=gemma4:31b-cloud`<br>`LLM_API_KEY=…` |
| **Local Ollama** | Install [Ollama](https://ollama.com), then `ollama pull gemma3:12b` | `LLM_BASE_URL=http://localhost:11434/v1`<br>`LLM_MODEL=gemma3:12b` |

The audit emits a large structured result, so use a **capable model** (12B+ or
hosted) — a 4B model can't fill the schema reliably.

**Firecrawl** (optional): set `FIRECRAWL_API_KEY` (free at
[firecrawl.dev](https://firecrawl.dev)) to enable the subtitle,
promotional-text and preview-video checks. Without it the audit runs on
Apple's free iTunes API alone and flags those three as *not assessed*.

## Run with Docker

```bash
cp .env.example .env      # set your LLM config
docker compose up         # → http://localhost:5173
```

Both processes run in one container. Ollama Cloud works as-is; for a *local*
Ollama set `LLM_BASE_URL=http://host.docker.internal:11434/v1` in `.env`.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Server + web UI together |
| `npm run build` | Production build of both |
| `npm test` | Unit tests (35) |
| `npm run typecheck` | Strict type-check across both apps |

## Tech stack

TypeScript · Mastra · Ollama (OpenAI-compatible) · Firecrawl · LibSQL · Zod ·
React 19 · Vite · Tailwind CSS v4.
