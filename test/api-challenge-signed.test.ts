import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const fp = 'a'.repeat(64);
const payload = Buffer.from(JSON.stringify({ kid: 'fixture', tenant: 'org-1', fp, trust: 'clean', exp: 4102444800 }));
const token = payload.toString('base64url') + '.' + sign(null, payload, privateKey).toString('base64url');
const keys = [{ kid: 'fixture', public_key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }];
afterEach(() => vi.unstubAllGlobals());

it.each(['revoked', 'insufficient-trust'])('Netlify preserves the signed-token %s reason and recoverability', async reason => {
  vi.resetModules();
  const config = { mode: 'enforce', routes: ['/api/*'], allow: { search_engines: false, ai_crawlers: false, monitoring: false }, keys, active_credentials: [], generated_at: 0, denied_fps: reason === 'revoked' ? [fp] : [], route_min_trust: reason === 'insufficient-trust' ? [{ pattern: '/api/*', min_trust: 'human-likely' }] : [] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(config))));
  const env: Record<string, string> = { WEBDECOY_SITE_KEY: 'org-1', WEBDECOY_SCANNER_ID: 'fixture', WEBDECOY_SENSOR_KEY: 'wds1.fixture', WEBDECOY_ENFORCEMENT: 'on' };
  const { makeHandler } = await import('../src/sensor/entry');
  const handler = makeHandler(name => env[name], fetch);
  const response = await handler(new Request('https://signed.example/api/data', { headers: { cookie: 'wd_clearance=' + token, accept: 'application/json' } }), { ip: '203.0.113.7', requestId: 'fixture', waitUntil: () => {}, next: async () => new Response('origin') }) as Response;
  expect(response.status).toBe(403);
  expect(response.headers.get('x-wd-challenge-reason')).toBe(reason);
  expect(await response.json()).toEqual({ error: 'clearance required', challenge: { version: 1, reason, recoverable: reason !== 'revoked' } });
});
