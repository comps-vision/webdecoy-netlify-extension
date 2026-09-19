import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NetlifyContext } from '../src/sensor/netlify';

/**
 * The Netlify validator's half of the cross-validator agreement (#1188).
 *
 * The same file the Worker replays, through the shipped handler rather than
 * through the decision module: the point is that this validator, with its own
 * runtime, its own verified-crawler step and its own bundle, reaches the same
 * verdict on the same request. Where it could not — a verified crawler it has
 * to resolve DNS for — it is given the same crawler identity the vectors name
 * and a resolver that answers as the real one did in the spike.
 */

const VECTORS = join(__dirname, '..', '..', 'clearance-worker', 'test', 'decision-vectors.json');

interface Vector {
  name: string;
  path: string;
  cookie?: string;
  headers?: Record<string, string>;
  verified_crawler?: boolean;
  site_mode?: string;
  config: Record<string, unknown> & { routes: string[] };
  want: { label: string; deciding_mode?: string; refuses_in_enforce: boolean };
}

const file = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  crawler: { user_agent: string; ip: string; ptr: string; category: string };
  cases: Vector[];
};
const { crawler, cases } = file;

const ENV: Record<string, string> = {
  WEBDECOY_SITE_KEY: 'org-1',
  WEBDECOY_SCANNER_ID: 'scanner-1',
  WEBDECOY_SENSOR_KEY: 'wds1.abc',
  WEBDECOY_ENFORCEMENT: 'on',
};

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

let hosts = 0;

/** The resolver Netlify's runtime provides, answering as it did in the spike. */
async function resolveDns(query: string, type: string): Promise<string[]> {
  const reverse = crawler.ip.split('.').reverse().join('.') + '.in-addr.arpa';
  if (type === 'PTR' && query === reverse) return [crawler.ptr];
  if (type === 'A' && query === crawler.ptr.replace(/\.$/, '')) return [crawler.ip];
  throw new Error('NXDOMAIN');
}

async function verdictFor(v: Vector, mode: 'monitor' | 'enforce'): Promise<{ label: string; refused: boolean }> {
  vi.resetModules();
  const config = {
    mode,
    allow: { search_engines: true, ai_crawlers: true, monitoring: true },
    keys: [],
    active_credentials: [],
    denied_fps: [],
    generated_at: 0,
    ...v.config,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/v1/clearance/config')) return new Response(JSON.stringify(config), { status: 200 });
      return new Response('{}', { status: 200 });
    })
  );
  vi.stubGlobal('Deno', { resolveDns });
  const { makeHandler } = await import('../src/sensor/entry');
  const handler = makeHandler((name) => ENV[name], fetch as typeof fetch);

  const headers: Record<string, string> = {
    accept: 'text/html',
    'user-agent': v.verified_crawler ? crawler.user_agent : BROWSER_UA,
    ...(v.headers ?? {}),
  };
  if (v.cookie) headers.cookie = v.cookie;

  hosts += 1;
  let forwarded: Request | undefined;
  const context: NetlifyContext = {
    ip: v.verified_crawler ? crawler.ip : '203.0.113.7',
    requestId: 'r',
    waitUntil: () => undefined,
    next: async (request?: Request) => {
      forwarded = request;
      return new Response('ORIGIN', { status: 200 });
    },
  };
  const result = await handler(new Request(`https://v${hosts}.example${v.path}`, { headers }), context);
  const response = result as Response | undefined;
  const refused = response?.status === 403;
  return { label: forwarded?.headers.get('x-wd-clearance') ?? (refused ? 'challenged' : ''), refused };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Netlify validator answers every cross-validator case the same way', () => {
  for (const v of cases) {
    it(v.name, async () => {
      const monitored = await verdictFor(v, (v.site_mode as 'monitor' | 'enforce') ?? 'monitor');
      expect(monitored.label).toBe(v.want.label);
      const enforcing = await verdictFor(v, 'enforce');
      expect(enforcing.refused).toBe(v.want.refuses_in_enforce);
    });
  }
});
