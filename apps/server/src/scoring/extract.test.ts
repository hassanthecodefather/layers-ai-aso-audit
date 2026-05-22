import { describe, it, expect } from 'vitest';
import { extractJsonObject } from './extract';

describe('extractJsonObject', () => {
  it('returns a clean JSON object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips markdown code fences', () => {
    const text = '```json\n{"a":1,"b":2}\n```';
    expect(extractJsonObject(text)).toBe('{"a":1,"b":2}');
  });

  it('ignores prose before and after the object', () => {
    const text = 'Here is the audit:\n{"score":7}\nHope that helps!';
    expect(extractJsonObject(text)).toBe('{"score":7}');
  });

  it('skips a reasoning model think block', () => {
    const text = '<think>let me reason { not json }</think>\n{"real":true}';
    expect(extractJsonObject(text)).toBe('{"real":true}');
  });

  it('balance-matches nested objects', () => {
    const json = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJsonObject(`prefix ${json} suffix`)).toBe(json);
  });

  it('is not fooled by braces inside strings', () => {
    const json = '{"text":"a } brace { in a string"}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('handles escaped quotes inside strings', () => {
    const json = '{"text":"she said \\"hi\\" }"}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('returns null when there is no JSON object', () => {
    expect(extractJsonObject('no json here at all')).toBeNull();
  });
});
