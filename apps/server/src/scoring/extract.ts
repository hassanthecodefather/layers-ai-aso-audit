/**
 * Pull a single JSON object out of an LLM response.
 *
 * Models rarely return clean JSON: they wrap it in ```json fences, prepend a
 * sentence of prose, or — for reasoning models — emit a `<think>` block
 * first. This strips all of that and returns the first balanced `{...}`
 * object, brace-matched so trailing prose can't break it.
 */
export function extractJsonObject(text: string): string | null {
  // Drop reasoning-model think blocks and markdown code fences.
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '');

  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return cleaned.slice(start, i + 1);
    }
  }
  return null;
}
