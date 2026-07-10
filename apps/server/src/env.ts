const REQUIRED: Record<string, string> = {
  DATABASE_URL: 'Postgres connection string (e.g. postgres://user:pass@host:5432/db)',
  ASO_JWT_SECRET: 'Secret key for signing JWT access tokens (min 32 chars)',
  APP_KITTI_API_KEY: 'AppKittie API key — required for identity-grounded competitor discovery (D3)',
  FIRECRAWL_API_KEY: 'Firecrawl API key — required for App Store page crawling (subtitle, screenshots)',
  ASC_ENCRYPTION_KEY: '32-byte base64 key for AES-256-GCM encryption of ASC private keys (generate: openssl rand -base64 32)',
};

const GEMINI_KEY_NAMES = ['LLM_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] as const;
const WEBSEARCH_KEY_NAMES = ['TAVILY_API_KEY', 'EXA_API_KEY'] as const;

export function validateEnv(): void {
  const missing: string[] = [];

  for (const [key, desc] of Object.entries(REQUIRED)) {
    if (!process.env[key]?.trim()) {
      missing.push(`  ${key}: ${desc}`);
    }
  }

  const hasGeminiKey = GEMINI_KEY_NAMES.some((k) => process.env[k]?.trim());
  if (!hasGeminiKey) {
    missing.push(`  LLM_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY): Google AI Studio API key`);
  }

  const hasWebSearchKey = WEBSEARCH_KEY_NAMES.some((k) => process.env[k]?.trim());
  if (!hasWebSearchKey) {
    missing.push(`  TAVILY_API_KEY (or EXA_API_KEY): Web search key — required for identity corroboration and footprint analysis`);
  }

  if (missing.length > 0) {
    console.error('Missing required environment variables:\n' + missing.join('\n'));
    process.exit(1);
  }
}
