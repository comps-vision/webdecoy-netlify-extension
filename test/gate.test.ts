import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NetlifyContext } from '../src/sensor/netlify';

/**
 * The clearance gate on Netlify (#1188).
 *
 * Two properties matter more than any feature here. A site that has not set
 * WEBDECOY_ENFORCEMENT must behave exactly as it did when this function was a
 * sensor and nothing else — no config fetch, no Response, ever. And a site
 * that has opted in must still be served when anything goes wrong: config
 * unreachable, malformed token, crypto failure, DNS failure, an unexpected
 * exception. Both are asserted on the shipped handler, not on a seam.
 *
 * The config cache in validator-parts lives for a minute per host, so every
 * test uses its own hostname rather than sharing one and hoping.
 */

const ORIGIN_BODY = 'ORIGIN OK';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const BASE_ENV: Record<string, string> = {
  WEBDECOY_SITE_KEY: 'org-1',
  WEBDECOY_SCANNER_ID: 'scanner-1',
  WEBDECOY_SENSOR_KEY: 'wds1.abc',
};

let host = 0;
function nextHost(): string {
  host += 1;
  return `site${host}.example`;
}

interface ConfigShape {
  mode: string;
  routes: string[];
  [key: string]: unknown;
}

function config(overrides: Partial<ConfigShape> = {}): ConfigShape {
  return {
    mode: 'enforce',
    routes: ['/protected/*'],
    allow: { search_engines: true, ai_crawlers: false, monitoring: false },
    keys: [],
    active_credentials: [],
    denied_fps: [],
    generated_at: 0,
    ...overrides,
  };
}

/** Requests, with a browser user agent unless a crawler is the point. */
function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { 'user-agent': BROWSER_UA, accept: 'text/html', ...headers } });
}

function ctx(overrides: Partial<NetlifyContext> = {}): NetlifyContext & { waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    ip: '203.0.113.7',
    geo: { country: { code: 'US', name: 'United States' } },
    site: { id: 'site-1' },
    requestId: '01ABC',
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    next: async () => new Response(ORIGIN_BODY, { status: 200, headers: { 'x-origin': 'yes' } }),
    waited,
    ...overrides,
  };
}

/**
 * Load the handler with its own module registry, so one test's cached config
 * and open telemetry window cannot reach the next.
 */
async function loadHandler(
  env: Record<string, string>,
  opts: {
    config?: () => Response | Promise<Response>;
    onTelemetry?: (body: string) => void;
    resolveDns?: (query: string, recordType: string) => Promise<string[]>;
  } = {}
) {
  vi.resetModules();
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes('/api/v1/clearance/config')) {
        return opts.config ? await opts.config() : new Response(JSON.stringify(config()), { status: 200 });
      }
      if (url.includes('/api/v1/clearance/telemetry')) {
        opts.onTelemetry?.(String(init?.body ?? ''));
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    })
  );
  if (opts.resolveDns) {
    vi.stubGlobal('Deno', { resolveDns: opts.resolveDns });
  } else {
    vi.stubGlobal('Deno', undefined);
  }
  const { makeHandler } = await import('../src/sensor/entry');
  return { handler: makeHandler((name) => env[name], fetch as typeof fetch), calls };
}

const ENFORCING_ENV = { ...BASE_ENV, WEBDECOY_ENFORCEMENT: 'on' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a site that has not opted in', () => {
  it('returns undefined and never asks for a config, on a path the gate would refuse', async () => {
    const { handler, calls } = await loadHandler(BASE_ENV);
    const result = await handler(req(`https://${nextHost()}/protected/page`), ctx());
    expect(result).toBeUndefined();
    expect(calls.filter((u) => u.includes('/clearance/'))).toEqual([]);
  });

  it('still reports what it sees', async () => {
    const { handler, calls } = await loadHandler(BASE_ENV);
    const context = ctx();
    await handler(
      req(`https://${nextHost()}/protected/page`, { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.0)' }),
      context
    );
    await Promise.all(context.waited);
    expect(calls.some((u) => u.includes('/api/v1/detect/public'))).toBe(true);
  });

  it('is off for any value that does not plainly mean on', async () => {
    for (const value of ['', ' ', 'off', 'no', 'enforce', '0', 'ON!', 'maybe']) {
      const { handler, calls } = await loadHandler({ ...BASE_ENV, WEBDECOY_ENFORCEMENT: value });
      const result = await handler(req(`https://${nextHost()}/protected/page`), ctx());
      expect(result, `WEBDECOY_ENFORCEMENT=${JSON.stringify(value)}`).toBeUndefined();
      expect(calls.filter((u) => u.includes('/clearance/'))).toEqual([]);
    }
  });

  it('is on for the values the setup card tells people to use', async () => {
    for (const value of ['on', 'ON', ' true ', '1', 'yes', 'enabled']) {
      const { handler } = await loadHandler({ ...BASE_ENV, WEBDECOY_ENFORCEMENT: value });
      const result = await handler(req(`https://${nextHost()}/protected/page`), ctx());
      expect((result as Response | undefined)?.status, `WEBDECOY_ENFORCEMENT=${JSON.stringify(value)}`).toBe(403);
    }
  });
});

describe('a site that opted in', () => {
  it('refuses a request with no clearance on a protected path in enforce mode', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV);
    const res = (await handler(req(`https://${nextHost()}/protected/page`), ctx())) as Response;
    expect(res.status).toBe(403);
    expect(res.headers.get('x-wd-clearance')).toBe('challenged');
    expect(await res.text()).toContain('Checking your browser');
  });

  it('answers a non-HTML client with JSON rather than an interstitial', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV);
    const res = (await handler(
      new Request(`https://${nextHost()}/protected/data.json`, { headers: { accept: 'application/json' } }),
      ctx()
    )) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'clearance required' });
  });

  it('serves the same request in monitor mode, with the verdict for the origin', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV, {
      config: () => new Response(JSON.stringify(config({ mode: 'monitor' })), { status: 200 }),
    });
    let seen: Request | undefined;
    const res = (await handler(
      req(`https://${nextHost()}/protected/page`),
      ctx({
        next: async (request?: Request) => {
          seen = request;
          return new Response(ORIGIN_BODY, { status: 200 });
        },
      })
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ORIGIN_BODY);
    expect(seen?.headers.get('x-wd-clearance')).toBe('missing');
  });

  it('lets an unprotected path through and tells the origin so', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV);
    let seen: Request | undefined;
    const res = (await handler(
      req(`https://${nextHost()}/about`),
      ctx({
        next: async (request?: Request) => {
          seen = request;
          return new Response(ORIGIN_BODY, { status: 200 });
        },
      })
    )) as Response;
    expect(res.status).toBe(200);
    expect(seen?.headers.get('x-wd-clearance')).toBe('unscoped');
  });

  it('never lets a client supply its own verdict', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV);
    let seen: Request | undefined;
    await handler(
      req(`https://${nextHost()}/about`, { 'x-wd-clearance': 'valid', 'x-wd-class': 'verified' }),
      ctx({
        next: async (request?: Request) => {
          seen = request;
          return new Response(ORIGIN_BODY);
        },
      })
    );
    expect(seen?.headers.get('x-wd-clearance')).toBe('unscoped');
    expect(seen?.headers.get('x-wd-class')).toBeNull();
  });

  it('answers the deploy heartbeat with the mode and what this build applies', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV);
    const res = (await handler(req(`https://${nextHost()}/?__wd_clearance_check=nonce-1`), ctx())) as Response;
    const body = (await res.json()) as { wd_clearance: boolean; nonce: string; mode: string; capabilities: string[] };
    expect(body.wd_clearance).toBe(true);
    expect(body.nonce).toBe('nonce-1');
    expect(body.mode).toBe('enforce');
    expect(body.capabilities).toContain('bot_verification_rdns');
  });

  it('answers the attestation path before the gate, so earning clearance is not gated', async () => {
    const { handler, calls } = await loadHandler(ENFORCING_ENV, {
      config: () => new Response(JSON.stringify(config({ routes: ['/*'] })), { status: 200 }),
    });
    const res = (await handler(
      req(`https://${nextHost()}/.well-known/wd-clearance/pat?fp=abc`),
      ctx()
    )) as Response;
    expect(res.status).toBe(200);
    expect(calls.some((u) => u.includes('/api/v1/clearance/pat'))).toBe(true);
  });

  it('reports the outcome with the host, the build and its capabilities', async () => {
    const bodies: string[] = [];
    const { handler } = await loadHandler(ENFORCING_ENV, { onTelemetry: (b) => bodies.push(b) });
    const site = nextHost();
    // A window is held open for up to 20 s before it flushes, so the report
    // exists only once that timer has run.
    vi.useFakeTimers();
    await handler(req(`https://${site}/protected/page`), ctx());
    await vi.advanceTimersByTimeAsync(21_000);
    vi.useRealTimers();
    const report = JSON.parse(bodies.find((b) => b.includes(site)) ?? '{}');
    expect(report.host).toBe(site);
    expect(report.mode).toBe('enforce');
    expect(report.counts).toEqual({ missing: 1 });
    expect(report.reporter_version).toMatch(/^(netlify-[0-9a-f]{12}|__WD_NETLIFY_BUILD__)$/);
    expect(report.scanner_id).toBe('scanner-1');
    expect(report.capabilities).toContain('bot_verification_rdns');
  });

  /**
   * #1197: this validator applied credential limits and reported none of
   * them, because its report call listed the fields one by one and stopped
   * one short of the newest. A capability it declares but does not report
   * makes the dashboard read "covered" over a site that counts nothing, which
   * is the one thing #1121 was careful never to do.
   *
   * Asserted on the shipped handler, through a real signed token, so it holds
   * for whatever the decision carries next as well.
   */
  it('reports a genuine credential presented where it grants nothing', async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const publicKey = btoa(String.fromCharCode(...raw));
    const claims = {
      kid: 'k1',
      tenant: 'org-1',
      typ: 'machine',
      sub: 'cred-reports',
      iat: 1000,
      exp: 4102444800,
    };
    const payload = new TextEncoder().encode(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, payload));
    const b64url = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const token = `${b64url(payload)}.${b64url(sig)}`;

    const bodies: string[] = [];
    const { handler } = await loadHandler(ENFORCING_ENV, {
      onTelemetry: (b) => bodies.push(b),
      config: () =>
        new Response(
          JSON.stringify(
            config({
              keys: [{ kid: 'k1', public_key: publicKey }],
              restricted_credentials: [{ id: 'cred-reports', here: true, paths: ['/protected/reports/*'] }],
            })
          ),
          { status: 200 }
        ),
    });
    const site = nextHost();
    vi.useFakeTimers();
    // Its own path: granted, and nothing to report about it.
    const granted = await handler(
      req(`https://${site}/protected/reports/daily`, { 'x-wd-service-token': token }),
      ctx()
    );
    // Another protected path: the credential grants nothing, the request is
    // refused for having no clearance, and the presentation is counted.
    const refused = (await handler(
      req(`https://${site}/protected/admin`, { 'x-wd-service-token': token }),
      ctx()
    )) as Response;
    await vi.advanceTimersByTimeAsync(21_000);
    vi.useRealTimers();

    expect((granted as Response).status).toBe(200);
    expect(refused.status).toBe(403);
    const report = JSON.parse(bodies.find((b) => b.includes(site)) ?? '{}');
    expect(report.credential_presentations).toEqual([{ credential_id: 'cred-reports', outside_reach: 1 }]);
    expect(report.counts).toEqual({ machine: 1, missing: 1 });
  });
});

describe('fail open', () => {
  const failures: [string, Parameters<typeof loadHandler>[1]][] = [
    ['config unreachable', { config: () => Promise.reject(new Error('down')) }],
    ['config returns a 500', { config: () => new Response('nope', { status: 500 }) }],
    ['config is not JSON', { config: () => new Response('<html>', { status: 200 }) }],
  ];
  for (const [name, opts] of failures) {
    it(`serves the request when the ${name}`, async () => {
      const { handler } = await loadHandler(ENFORCING_ENV, opts);
      const result = await handler(req(`https://${nextHost()}/protected/page`), ctx());
      expect(result).toBeUndefined();
    });
  }

  it('serves the request when a token is malformed', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV, {
      config: () => new Response(JSON.stringify(config({ mode: 'monitor' })), { status: 200 }),
    });
    const res = (await handler(
      req(`https://${nextHost()}/protected/page`, { cookie: 'wd_clearance=not-a-token' }),
      ctx()
    )) as Response;
    expect(res.status).toBe(200);
  });

  it('refuses rather than passes when crypto itself fails on a protected path', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV, {
      config: () =>
        new Response(JSON.stringify(config({ keys: [{ kid: 'k1', public_key: 'not-base64!!' }] })), { status: 200 }),
    });
    const res = (await handler(
      req(`https://${nextHost()}/protected/page`, { cookie: 'wd_clearance=aaa.bbb' }),
      ctx()
    )) as Response;
    // A token that cannot be verified is not a valid token; the visitor is
    // challenged and self-heals. What must never happen is a thrown error.
    expect(res.status).toBe(403);
  });

  it('serves the request when the runtime cannot continue the chain', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV, {
      config: () => new Response(JSON.stringify(config({ routes: [] })), { status: 200 }),
    });
    const result = await handler(
      req(`https://${nextHost()}/about`),
      ctx({
        next: async () => {
          throw new Error('runtime');
        },
      })
    );
    expect(result).toBeUndefined();
  });

  it('serves the request when the context is not what the runtime promised', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV);
    const result = await handler(
      req(`https://${nextHost()}/about`),
      { ip: '', next: undefined } as unknown as NetlifyContext
    );
    expect(result).toBeUndefined();
  });

  it('serves the request when reporting the outcome throws', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV, {
      config: () => new Response(JSON.stringify(config({ routes: [] })), { status: 200 }),
    });
    const res = (await handler(
      req(`https://${nextHost()}/about`),
      ctx({
        waitUntil: () => {
          throw new Error('no waitUntil for you');
        },
      })
    )) as Response;
    expect(res.status).toBe(200);
  });
});

describe('verified crawlers (#1187)', () => {
  const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const googlebotDns = async (query: string, type: string): Promise<string[]> => {
    if (type === 'PTR' && query === '1.66.249.66.in-addr.arpa') return ['crawl-66-249-66-1.googlebot.com.'];
    if (type === 'A' && query === 'crawl-66-249-66-1.googlebot.com') return ['66.249.66.1'];
    throw new Error('NXDOMAIN');
  };

  it('lets a forward-confirmed search engine through a protected path', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV, { resolveDns: googlebotDns });
    let seen: Request | undefined;
    const res = (await handler(
      req(`https://${nextHost()}/protected/page`, { 'user-agent': GOOGLEBOT }),
      ctx({
        ip: '66.249.66.1',
        next: async (request?: Request) => {
          seen = request;
          return new Response(ORIGIN_BODY);
        },
      })
    )) as Response;
    expect(res.status).toBe(200);
    expect(seen?.headers.get('x-wd-clearance')).toBe('verified-bot');
  });

  it('does not escalate a crawler whose reverse DNS does not confirm: it is challenged, never called impersonation', async () => {
    const bodies: string[] = [];
    const { handler } = await loadHandler(ENFORCING_ENV, {
      onTelemetry: (b) => bodies.push(b),
      resolveDns: async () => ['fake-googlebot.example.'],
    });
    const site = nextHost();
    vi.useFakeTimers();
    const res = (await handler(
      req(`https://${site}/protected/page`, { 'user-agent': GOOGLEBOT }),
      ctx({ ip: '198.51.100.9' })
    )) as Response;
    await vi.advanceTimersByTimeAsync(21_000);
    vi.useRealTimers();
    expect(res.status).toBe(403);
    const report = JSON.parse(bodies.find((b) => b.includes(site)) ?? '{}');
    expect(report.counts).toEqual({ missing: 1 });
    expect(JSON.stringify(report)).not.toContain('impersonation');
  });

  it('asks DNS nothing for a browser, and nothing on an unprotected path', async () => {
    const queries: string[] = [];
    const { handler } = await loadHandler(ENFORCING_ENV, {
      resolveDns: async (q) => {
        queries.push(q);
        return [];
      },
    });
    const site = nextHost();
    await handler(req(`https://${site}/protected/page`), ctx({ ip: '66.249.66.1' })); // a browser
    await handler(req(`https://${site}/about`, { 'user-agent': GOOGLEBOT }), ctx({ ip: '66.249.66.1' }));
    expect(queries).toEqual([]);
  });

  it('serves the request when DNS fails outright', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV, {
      config: () => new Response(JSON.stringify(config({ mode: 'monitor' })), { status: 200 }),
      resolveDns: async () => {
        throw new Error('resolver on fire');
      },
    });
    const res = (await handler(
      req(`https://${nextHost()}/protected/page`, { 'user-agent': GOOGLEBOT }),
      ctx({ ip: '66.249.66.1' })
    )) as Response;
    expect(res.status).toBe(200);
  });

  it('verifies nothing when the runtime has no resolver at all', async () => {
    const { handler } = await loadHandler(ENFORCING_ENV);
    const res = (await handler(
      req(`https://${nextHost()}/protected/page`, { 'user-agent': GOOGLEBOT }),
      ctx({ ip: '66.249.66.1' })
    )) as Response;
    expect(res.status).toBe(403);
  });
});
