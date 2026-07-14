/**
 * AppKittie keyword-data client (Phase C4 — interim popularity provider).
 *
 * Implements AsaClient behind the existing seam. Transport: MCP JSON-RPC 2.0
 * over HTTPS — the MCP tools are consumed programmatically here; they are
 * NEVER registered on the agent toolset (decision #6: code decides what to
 * query, the agent only sees normalized facts in the prompt).
 *
 * Provenance: "AppKittie estimate" — panel/estimation data, not Apple-
 * authoritative. The deterministic linter/gap findings remain load-bearing;
 * AppKittie ranks and enriches them.
 *
 * Graceful degradation: any network/parse error returns available=false so
 * the audit is honest rather than crashing.
 */

import type { AsaClient, AsaVolume } from './asa-client';
import { getGateway } from '../cost/gateway';

const MCP_URL = 'https://mcp.appkittie.com';

// ── MCP wire types ────────────────────────────────────────────────────────────

interface McpContent { type: string; text: string; }

interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

interface McpResponse {
  jsonrpc: string;
  id: string;
  result?: McpToolResult;
  error?: { code: number; message: string };
}

// ── AppKittie domain shape ────────────────────────────────────────────────────

export interface AppKittieTopApp {
  appStoreId: string;
  title?: string;
  averageRating?: number;
  ratingCount?: number;
}

interface AppKittieKwData {
  keyword: string;
  popularity: number;
  difficulty: number;
  appsCount: number;
  trafficScore: number;
  topApps?: AppKittieTopApp[];   // may be absent on API error
}

// ── Client ────────────────────────────────────────────────────────────────────

export class AppKittieClient implements AsaClient {
  constructor(private readonly apiKey: string) {}

  async getVolume(term: string, storefront?: string): Promise<AsaVolume> {
    const country = (storefront ?? 'us').toUpperCase();
    try {
      const payload = await this.#callTool<{ data: AppKittieKwData }>(
        'get_keyword_difficulty',
        { keyword: term, country, source: 'apple_mobile' },
        `${term.toLowerCase()}:${country.toLowerCase()}`,
      );
      const { popularity, difficulty } = payload.data;
      return {
        available: true,
        popularity,
        difficulty,
        label: `popularity ${popularity}/100 · difficulty ${difficulty}/100 (AppKittie estimate)`,
      };
    } catch (err) {
      console.warn(`[appkittie] getVolume failed for "${term}": ${String(err)}`);
      return { available: false, label: 'popularity unavailable' };
    }
  }

  /** Returns apps ranked for a keyword (identity-grounded competitor discovery). */
  async getTopApps(term: string, storefront = 'us'): Promise<AppKittieTopApp[]> {
    try {
      const country = storefront.toUpperCase();
      const payload = await this.#callTool<{ data: AppKittieKwData }>(
        'get_keyword_difficulty',
        { keyword: term, country, source: 'apple_mobile' },
        `${term.toLowerCase()}:${country.toLowerCase()}`,
      );
      return payload.data.topApps ?? [];
    } catch {
      return [];  // graceful — never throws, never fabricates
    }
  }

  async #callTool<T>(name: string, args: Record<string, unknown>, entityId?: string): Promise<T> {
    const res = await getGateway().fetch(MCP_URL, { kind: 'app', upstream: 'appkittie', entityId }, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) {
      throw new Error(`AppKittie HTTP ${res.status} ${res.statusText}`);
    }
    const json = await this.#parseResponse(res);
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    const result = json.result!;
    if (result.isError) {
      throw new Error(`Tool error: ${result.content[0]?.text ?? 'unknown'}`);
    }
    const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
    return JSON.parse(text) as T;
  }

  /** Parse either a JSON response or a text/event-stream (SSE) response. */
  async #parseResponse(res: Response): Promise<McpResponse> {
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const raw = await res.text();
      // SSE format: extract the last `data: {…}` line.
      const dataLine = raw
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('data: ') && l.length > 6);
      if (!dataLine) throw new Error('No data line in SSE response');
      return JSON.parse(dataLine.slice(6)) as McpResponse;
    }
    return res.json() as Promise<McpResponse>;
  }
}
