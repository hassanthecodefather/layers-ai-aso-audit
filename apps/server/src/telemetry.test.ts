import { describe, it, expect } from 'vitest';

describe('telemetry logger', () => {
  it('exports an object with info, debug, warn, error methods', async () => {
    const { logger } = await import('./telemetry');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
