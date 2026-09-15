import { describe, expect, it, vi } from 'vitest';
import { classify, isStaticAsset } from '../src/sensor/classify';
import { buildPayload, clientSignals, SOURCE } from '../src/sensor/payload';
import { makeHandler, readEnv, config } from '../src/sensor/entry';
import type { NetlifyContext } from '../src/sensor/netlify';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function req(path: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(`https://blog.example.com${path}`, { method, headers });
}
function browserReq(path = '/'): Request {
  return req(path, { 'user-agent': BROWSER_UA, 'accept-language': 'en', 'sec-fetch-mode': 'navigate', 'sec-ch-ua': '"Chromium";v="128"' });
}
function ctx(overrides: Partial<NetlifyContext> = {}): NetlifyContext & { waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    ip: '203.0.113.7',
    geo: { country: { code: 'US', name: 'United States' } },
    site: { id: 'site-1', name: 'blog', url: 'https://blog.example.com' },
    requestId: '01ABC',
    waitUntil: (p) => { waited.push(p); },
    next: async () => new Response('origin'),
    waited,
    ...overrides,
  };
}
const ENV: Record<string, string> = {
  WEBDECOY_SITE_KEY: 'org-1',
  WEBDECOY_SCANNER_ID: 'scanner-1',
  WEBDECOY_SENSOR_KEY: 'wds1.abc',
};
const getEnv = (name: string) => ENV[name];

describe('classify', () => {
  it('flags a known crawler, a tool, a crawler path and an empty user agent', () => {
    expect(classify(req('/', { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.0)' }), new URL('https://x.test/')).flags).toContain('known_crawler_ua');
    expect(classify(req('/', { 'user-agent': 'curl/8.7.1' }), new URL('https://x.test/')).flags).toContain('http_client_ua');
    expect(classify(browserReq('/robots.txt'), new URL('https://x.test/robots.txt')).flags).toContain('crawler_path');
    expect(classify(req('/'), new URL('https://x.test/')).flags).toContain('no_user_agent');
  });

  it('names the agent from the shared table', () => {
    expect(classify(req('/', { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.0)' }), new URL('https://x.test/')).ai).toBe('GPTBot');
  });

  it('is silent on a real browser', () => {
    expect(classify(browserReq(), new URL('https://blog.example.com/')).send).toBe(false);
  });

  it('flags a Chromium claim with no client hints, but not an iOS wrapper', () => {
    const chrome = req('/', { 'user-agent': BROWSER_UA, 'accept-language': 'en', 'sec-fetch-mode': 'navigate' });
    expect(classify(chrome, new URL('https://x.test/')).flags).toContain('missing_client_hints');
    const ios = req('/', { 'user-agent': 'Mozilla/5.0 (iPhone) CriOS/128.0 Mobile Safari', 'accept-language': 'en', 'sec-fetch-mode': 'navigate' });
    expect(classify(ios, new URL('https://x.test/')).flags).not.toContain('missing_client_hints');
  });

  it('labels the reserved test trigger', () => {
    expect(classify(req('/', { 'user-agent': 'WebDecoy-Test/1.0' }), new URL('https://x.test/')).flags).toContain('test_trigger');
  });

  it('skips assets but never robots.txt or sitemaps', () => {
    expect(isStaticAsset('/main.js')).toBe(true);
    expect(isStaticAsset('/_next/static/chunk.js')).toBe(true);
    expect(isStaticAsset('/robots.txt')).toBe(false);
    expect(isStaticAsset('/sitemap.xml')).toBe(false);
    expect(isStaticAsset('/blog/post')).toBe(false);
  });
});

describe('payload', () => {
  it('carries the source, the client IP from the context, and Netlify evidence', () => {
    const r = req('/blog', { 'user-agent': 'curl/8.7.1', 'x-nf-request-id': 'abc', 'accept-encoding': 'gzip' });
    const v = classify(r, new URL(r.url));
    const p = buildPayload(r, new URL(r.url), 'org-1', 'scanner-1', ctx(), v) as Record<string, any>;
    expect(p.source).toBe(SOURCE);
    expect(SOURCE).toBe('netlify_edge');
    expect(p.aid).toBe('org-1');
    expect(p.sid).toBe('scanner-1');
    expect(p.ip).toBe('203.0.113.7');
    expect(p.ua).toBe('curl/8.7.1');
    expect(p.s).toBe(0);
    expect(p.metadata).toMatchObject({ edge: 'netlify', method: 'GET', country: 'US', netlify_site: 'site-1' });
    expect(p.cs.hn).not.toContain('x-nf-request-id');
    expect(p.cs.hn).toContain('accept-encoding');
  });

  it('leaves the TLS fields empty rather than inventing them', () => {
    const cs = clientSignals(req('/')) as Record<string, string>;
    expect(cs.ja4).toBe('');
    expect(cs.tls).toBe('');
  });
});

describe('the edge function', () => {
  it('is a no-op without its three environment variables', () => {
    const fetcher = vi.fn();
    const handler = makeHandler(() => undefined, fetcher as unknown as typeof fetch);
    const c = ctx();
    expect(handler(req('/', { 'user-agent': 'curl/8.7.1' }), c)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(readEnv(() => undefined)).toBeNull();
  });

  it('reports an automated request after the response, with the sensor key, and continues the chain', async () => {
    const fetcher = vi.fn(async () => new Response('ok'));
    const handler = makeHandler(getEnv, fetcher as unknown as typeof fetch);
    const c = ctx();
    expect(handler(req('/wp-login.php', { 'user-agent': 'python-requests/2.31' }), c)).toBeUndefined();
    expect(c.waited).toHaveLength(1);
    await c.waited[0];
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://in.webdecoy.com/api/v1/detect/public');
    expect((init.headers as Record<string, string>)['x-wd-sensor-key']).toBe('wds1.abc');
    const body = JSON.parse(init.body as string);
    expect(body.source).toBe('netlify_edge');
    expect(body.f).toContain('http_client_ua');
  });

  it('does not report browsers or assets', () => {
    const fetcher = vi.fn();
    const handler = makeHandler(getEnv, fetcher as unknown as typeof fetch);
    handler(browserReq('/'), ctx());
    handler(req('/app.js', { 'user-agent': 'curl/8.7.1' }), ctx());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never throws, whatever the beacon does', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network down'); });
    const handler = makeHandler(getEnv, fetcher as unknown as typeof fetch);
    const c = ctx();
    expect(() => handler(req('/', { 'user-agent': 'curl/8.7.1' }), c)).not.toThrow();
    await expect(c.waited[0]).resolves.toBeUndefined();
    const broken = makeHandler(() => { throw new Error('env exploded'); }, fetcher as unknown as typeof fetch);
    expect(() => broken(req('/'), ctx())).not.toThrow();
  });

  it('honours a custom ingest base and defaults otherwise', () => {
    expect(readEnv((n) => ({ ...ENV, WEBDECOY_INGEST: 'https://ingest.test/' })[n])?.ingest).toBe('https://ingest.test');
    expect(readEnv(getEnv)?.ingest).toBe('https://in.webdecoy.com');
  });

  it('declares a catch-all path that bypasses itself on error', () => {
    expect(config.path).toBe('/*');
    expect(config.onError).toBe('bypass');
    expect(config.excludedPath).toContain('/_next/static/*');
  });
});
