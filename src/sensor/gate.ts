/**
 * The clearance gate on Netlify (#1188): the third validator.
 *
 * Opt-in per site with one more environment variable. A site that has not set
 * it never reaches this file — the injected function returns undefined on
 * every path, exactly as it did when it was a sensor and nothing else.
 *
 * Nothing here is a second implementation of the gate. The decision, the
 * config fetch, the deploy heartbeat, the attestation proxy, the verdict
 * headers, the challenge page and the telemetry are the Cloudflare Worker's
 * own modules, imported; what this file adds is the Netlify runtime around
 * them and the one thing Netlify does not hand a validator, which is how a
 * verified crawler is recognised (verified-bots.ts, #1187).
 *
 * FAIL-OPEN, as everywhere: config unreachable, malformed token, crypto
 * failure, DNS failure, an unexpected exception — every one of them returns
 * undefined, and Netlify serves the request as if the function were not
 * there. On a customer's site that is the difference between a reporting bug
 * and an outage.
 */

import { evaluate } from '../../../clearance-worker/src/decision';
import {
  getConfig,
  healthResponse,
  proxyPAT,
  challenge,
  withoutClientTags,
  HEALTHCHECK_PARAM,
  PAT_PATH,
  VERDICT_HEADER,
  CLASS_HEADER,
} from '../../../clearance-worker/src/validator-parts';
import { recordVerdict } from '../../../clearance-worker/src/telemetry';
import { normalizeHost } from '../../../clearance-worker/src/host';
import { NETLIFY_VALIDATOR_CAPABILITIES } from './capabilities';
import { verifiedBotCategory } from './verified-bots';
import type { NetlifyContext } from './netlify';

/** What the gate needs from the site's environment. */
export interface GateEnv {
  siteKey: string;
  scannerId: string;
  sensorKey: string;
  /** WebDecoy ingest, the same base the sensor beacons to. */
  ingest: string;
  /** Which build is running, for report provenance (#988). */
  version: string;
}

/**
 * Decide one request.
 *
 * Returns a Response to refuse or answer it, or undefined to let Netlify
 * carry on down the chain. The chain below this function is everything the
 * customer controls: their own edge functions, their framework's middleware
 * where it runs after us, their redirects, their origin (docs/NETLIFY_EXTENSION.md §9).
 */
export async function runGate(
  request: Request,
  context: NetlifyContext,
  env: GateEnv
): Promise<Response | undefined> {
  try {
    const url = new URL(request.url);
    const healthNonce = url.searchParams.get(HEALTHCHECK_PARAM);
    const requestHost = normalizeHost(url.hostname);
    const config = await getConfig(
      { apiBase: env.ingest, siteKey: env.siteKey },
      requestHost
    );

    // Deploy heartbeat (#139), answered by the validator itself so the
    // dashboard can tell "installed" from "deployed".
    if (healthNonce !== null) {
      return healthResponse(
        healthNonce,
        config ? config.mode : 'unknown',
        env.siteKey,
        NETLIFY_VALIDATOR_CAPABILITIES
      );
    }

    // Earning clearance must not require clearance: the attestation exchange
    // is answered before the gate, as on the Worker.
    if (url.pathname === PAT_PATH) {
      return proxyPAT(request, env.ingest);
    }

    if (!config) return undefined; // config unreachable -> the chain continues

    const verdict = await evaluate(request, config, {
      siteKey: env.siteKey,
      // Netlify verifies crawlers itself, and pays a DNS round trip for the
      // answer, so it is asked for only where it can change one (#1187).
      verifiedBotCategory: (req, covered) =>
        verifiedBotCategory(context.ip ?? '', req.headers.get('user-agent') ?? '', covered),
    });

    // The return path (#435, #1189). Same contract as on the Worker: returns
    // void, throws nothing, sends inside waitUntil. Deleting this call must
    // leave the gate's behaviour identical.
    recordVerdict(
      verdict.label,
      verdict.mode,
      url.hostname,
      {
        siteKey: env.siteKey,
        apiBase: env.ingest,
        scannerId: env.scannerId,
        sensorKey: env.sensorKey,
        bundleVersion: env.version,
        capabilities: NETLIFY_VALIDATOR_CAPABILITIES,
      },
      { waitUntil: (p) => context.waitUntil?.(p) },
      Date.now(),
      verdict.pattern,
      verdict.previews,
      verdict.behavior
    );

    if (verdict.pass || verdict.mode !== 'enforce') {
      return forwardWithVerdict(request, context, verdict.label);
    }
    return challenge(request, env.ingest, env.siteKey);
  } catch {
    // Fail open, always.
    return undefined;
  }
}

/**
 * Hand the origin the verdict, the way the Worker does.
 *
 * The header exists so an origin can act on it — the Node SDK reads it — which
 * is exactly why an inbound copy is stripped first: nothing downstream may see
 * a value a client supplied. Forwarding a modified request through
 * `context.next()` was measured not to change what redirects and rewrites do
 * (docs/NETLIFY_EXTENSION.md §9b).
 *
 * If `next` is missing or throws, the request is let through untouched rather
 * than failed: a missing header is a lost annotation, a failed next is a lost
 * page.
 */
async function forwardWithVerdict(
  request: Request,
  context: NetlifyContext,
  verdict: string
): Promise<Response | undefined> {
  try {
    if (typeof context.next !== 'function') return undefined;
    const clean = withoutClientTags(request);
    const headers = new Headers(clean.headers);
    headers.set(VERDICT_HEADER, verdict);
    // The sensor's class header is the Worker's; this validator does not
    // classify on the request path, so it says nothing rather than guessing.
    headers.delete(CLASS_HEADER);
    return await context.next(new Request(clean, { headers }));
  } catch {
    return undefined;
  }
}
