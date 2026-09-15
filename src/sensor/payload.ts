import type { NetlifyContext } from './netlify';
import type { SensorVerdict } from './classify';

/** The detection source every row from this sensor carries. */
export const SOURCE = 'netlify_edge';

/** Headers Netlify's edge adds; not the client's, so not fingerprint material. */
const EDGE_INJECTED = /^(?:x-nf-|x-forwarded-|x-country|x-language|x-bb-|via$|forwarded$)/;

/**
 * The client's own signals (#873). Header names, language and encoding are
 * what the network tier of the actor model fingerprints; they must be the
 * CLIENT's, not the edge's, which is why Netlify's injected headers are
 * excluded. Netlify exposes no TLS fingerprint, so those fields stay empty.
 */
export function clientSignals(request: Request): Record<string, unknown> {
  const h = request.headers;
  const names: string[] = [];
  for (const [name] of h) {
    const n = name.toLowerCase();
    if (!EDGE_INJECTED.test(n)) names.push(n);
  }
  names.sort();
  return {
    hn: names,
    al: h.get('accept-language') ?? '',
    ae: h.get('accept-encoding') ?? '',
    ja3: '',
    ja4: '',
    tls: '',
    tc: '',
  };
}

/**
 * The beacon ingest receives: the same shape the Cloudflare Worker sends,
 * with Netlify's evidence in place of Cloudflare's. No client score, no
 * flags beyond the classifier's, no fingerprint: a server-side observation,
 * scored as one.
 */
export function buildPayload(
  request: Request,
  url: URL,
  siteKey: string,
  scannerId: string,
  context: NetlifyContext,
  v: SensorVerdict
): Record<string, unknown> {
  const h = request.headers;
  return {
    aid: siteKey,
    sid: scannerId,
    v: 2,
    s: 0,
    f: v.flags,
    ai: v.ai,
    source: SOURCE,
    ua: h.get('user-agent') ?? '',
    ip: context.ip ?? '',
    url: url.toString(),
    ref: h.get('referer') ?? '',
    ts: Date.now(),
    cs: clientSignals(request),
    metadata: {
      edge: 'netlify',
      method: request.method,
      country: context.geo?.country?.code ?? null,
      netlify_site: context.site?.id ?? '',
      netlify_request_id: context.requestId ?? '',
    },
  };
}
