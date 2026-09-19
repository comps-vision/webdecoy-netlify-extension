import type { NetlifyContext } from './netlify';
import { classify, isStaticAsset } from './classify';
import { buildPayload } from './payload';
import { runGate } from './gate';
import { BUILD } from './build';

/**
 * The injected edge function (#996).
 *
 * Runs on every request the config below matches, decides from headers and
 * path whether the request looks automated, and if so reports it to ingest
 * after the response has been sent. It returns nothing, which tells Netlify
 * to continue the chain untouched: the site's own edge functions, framework
 * middleware and origin see exactly the request they would have seen. A
 * reporting failure is swallowed. Nothing here can change what a visitor
 * gets, and nothing here blocks.
 *
 * Identity comes from three environment variables the customer set on the
 * site (Functions scope): WEBDECOY_SITE_KEY (the organization id the sensor
 * reports under), WEBDECOY_SCANNER_ID (the site's scanner) and
 * WEBDECOY_SENSOR_KEY (proves to ingest that this is a sensor WebDecoy
 * issued, which is what earns the raw-request scoring profile). Missing
 * variables make the function a no-op rather than an unproven reporter.
 *
 * A fourth variable, WEBDECOY_ENFORCEMENT, turns this function into the
 * clearance gate as well (#1188). Without it nothing below the sensor runs,
 * so a site that has not opted in behaves exactly as it did: every request is
 * observed and none is changed. With it, WebDecoy decides whether the site is
 * monitoring or enforcing; the variable only says the gate may run at all.
 */

const DEFAULT_INGEST = 'https://in.webdecoy.com';
const BEACON_TIMEOUT_MS = 2000;

export interface SensorEnv {
  siteKey: string;
  scannerId: string;
  sensorKey: string;
  ingest: string;
  /** Whether this site opted into the clearance gate (#1188). */
  enforcement: boolean;
}

/**
 * Values that turn the gate on. Anything else, including an empty string and
 * a typo, leaves it off: a variable nobody can read the meaning of must not
 * start changing responses on a customer's site.
 */
const ENFORCEMENT_ON = ['on', '1', 'true', 'yes', 'enabled'];

export function readEnv(get: (name: string) => string | undefined): SensorEnv | null {
  const siteKey = (get('WEBDECOY_SITE_KEY') ?? '').trim();
  const scannerId = (get('WEBDECOY_SCANNER_ID') ?? '').trim();
  const sensorKey = (get('WEBDECOY_SENSOR_KEY') ?? '').trim();
  if (!siteKey || !scannerId || !sensorKey) return null;
  const ingest = (get('WEBDECOY_INGEST') ?? '').trim().replace(/\/+$/, '') || DEFAULT_INGEST;
  const enforcement = ENFORCEMENT_ON.includes((get('WEBDECOY_ENFORCEMENT') ?? '').trim().toLowerCase());
  return { siteKey, scannerId, sensorKey, ingest, enforcement };
}

/** Sends one beacon. Never throws; never takes longer than the timeout. */
export async function sendBeacon(env: SensorEnv, payload: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    await fetcher(`${env.ingest}/api/v1/detect/public`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-sensor-key': env.sensorKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(BEACON_TIMEOUT_MS),
    });
  } catch {
    // A reporting failure must never become a serving failure.
  }
}

/**
 * The request handler, with its collaborators injectable for tests. Returns
 * undefined always: the chain continues.
 */
export function makeHandler(
  getEnv: (name: string) => string | undefined,
  fetcher: typeof fetch = fetch
) {
  return (request: Request, context: NetlifyContext): undefined | Promise<Response | undefined> => {
    let env: SensorEnv | null = null;
    try {
      env = readEnv(getEnv);
      if (!env) return undefined;
      const url = new URL(request.url);
      if (!isStaticAsset(url.pathname)) {
        const verdict = classify(request, url);
        if (verdict.send) {
          const payload = buildPayload(request, url, env.siteKey, env.scannerId, context, verdict);
          const beacon = sendBeacon(env, payload, fetcher);
          if (typeof context.waitUntil === 'function') {
            context.waitUntil(beacon);
          }
        }
      }
    } catch {
      // Same rule: the sensor is never the reason a page failed.
    }
    // Observation first, so a challenged request is reported exactly like one
    // that passed — the Worker's order.
    if (!env || !env.enforcement) return undefined;
    return runGate(request, context, {
      siteKey: env.siteKey,
      scannerId: env.scannerId,
      sensorKey: env.sensorKey,
      ingest: env.ingest,
      version: BUILD,
    });
  };
}

const handler = makeHandler((name) =>
  typeof Netlify !== 'undefined' ? Netlify.env.get(name) : undefined
);

export default handler;

export const config = {
  path: '/*',
  // Assets are skipped in code too; excluding them here saves the invocation.
  excludedPath: ['/*.css', '/*.js', '/*.mjs', '/*.map', '/*.png', '/*.jpg', '/*.jpeg', '/*.gif', '/*.webp', '/*.avif', '/*.svg', '/*.ico', '/*.woff', '/*.woff2', '/_next/static/*', '/_astro/*', '/.netlify/*'],
  // If the function itself throws, serve the request as if it were not there.
  onError: 'bypass',
};
