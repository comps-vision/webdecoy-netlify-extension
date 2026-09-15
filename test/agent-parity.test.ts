import { describe, expect, it } from 'vitest';
import { matchAgent } from '../src/sensor/classify';
import { AGENTS } from '../src/sensor/agents.generated';
import vectors from './parity-vectors.generated.json';

// The same table and the same vectors the Cloudflare Worker is held to: a
// Netlify row and a Worker row for one user agent must name the same agent.
describe('agent table parity with the registry', () => {
  it('has a vector for every agent', () => {
    const ids = new Set(AGENTS.map((row) => row[2]));
    expect(vectors.length).toBeGreaterThanOrEqual(ids.size);
  });

  it('answers every vector the way the Go matcher does', () => {
    const failures: string[] = [];
    for (const v of vectors as Array<{ userAgent: string; id?: string; matched: boolean }>) {
      const got = matchAgent(v.userAgent.toLowerCase());
      if (v.matched) {
        if (!got || got.id !== v.id) failures.push(`${JSON.stringify(v.userAgent)}: want ${v.id}, got ${got?.id ?? 'no match'}`);
      } else if (got) {
        failures.push(`${JSON.stringify(v.userAgent)}: want no match, got ${got.id}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
