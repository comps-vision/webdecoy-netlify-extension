import { AGENTS, type AgentKind } from './agents.generated';

/**
 * What a request looks like, from its headers and path alone (#996).
 *
 * A port of the Cloudflare Worker's classifier minus the Cloudflare-only
 * evidence (verified-bot category, TLS fingerprints), which Netlify's edge
 * does not expose. Same flags, same names, so ingest scores a Netlify row
 * with the same raw-request profile and the same signals as a Worker row.
 */
export interface SensorVerdict {
  send: boolean;
  flags: string[];
  ai: string;
}

export function matchAgent(ua: string): { name: string; id: string; kind: AgentKind } | null {
  for (const [token, name, id, kind] of AGENTS) {
    if (ua.includes(token)) return { name, id, kind };
  }
  return null;
}

// The trailing character class is load-bearing: a bare /bot/i would match
// phone-brand UAs that contain "CUBOT". Requiring a delimiter after the token
// means "Googlebot/2.1" matches and "CUBOT_NOTE_20" does not.
const GENERIC_BOT = /(?:bot|crawler|spider)(?:[/\s);,]|$)/i;

/** Paths essentially only crawlers request. */
const CRAWLER_PATHS = /^\/(?:robots\.txt|sitemap[\w.-]*\.xml|sitemaps?\/)/i;

/** Chromium-family UA that should therefore be sending client hints. */
const CLAIMS_CHROMIUM = /(?:chrome|chromium|edg)\//i;
const IOS_WRAPPER = /(?:crios|edgios|fxios)\//i;

export function classify(request: Request, url: URL): SensorVerdict {
  const flags: string[] = [];
  const h = request.headers;
  const rawUA = h.get('user-agent') ?? '';
  const ua = rawUA.toLowerCase();

  // The reserved test trigger (#677): a WebDecoy-Test/ user agent proves an
  // install end to end and is labeled a test by ingest, never a finding.
  if (ua.trimStart().startsWith('webdecoy-test/')) {
    flags.push('test_trigger');
  }
  if (h.get('signature-agent') || h.get('signature-input')) {
    flags.push('wba_signature');
  }

  const agent = matchAgent(ua);
  const ai = agent?.name ?? '';
  if (agent?.kind === 'crawler' || (!agent && GENERIC_BOT.test(rawUA))) {
    flags.push('known_crawler_ua');
  }
  if (agent?.kind === 'tool') {
    flags.push('http_client_ua');
  }
  if (CRAWLER_PATHS.test(url.pathname)) {
    flags.push('crawler_path');
  }
  if (url.protocol === 'https:' && CLAIMS_CHROMIUM.test(ua) && !IOS_WRAPPER.test(ua) && !h.get('sec-ch-ua')) {
    flags.push('missing_client_hints');
  }
  if (!rawUA) {
    flags.push('no_user_agent');
  }
  if (!h.get('accept-language')) {
    flags.push('no_language');
  }
  if (!h.get('sec-fetch-mode')) {
    flags.push('no_fetch_metadata');
  }
  return { send: flags.length > 0, flags, ai };
}

/** Static assets are never reported: a page load would otherwise become forty beacons. */
const STATIC_ASSET = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|txt|json|xml)$/i;
const STATIC_PREFIX = /^\/(?:_next\/static\/|_astro\/|assets\/|static\/|\.netlify\/)/;

export function isStaticAsset(pathname: string): boolean {
  if (CRAWLER_PATHS.test(pathname)) return false; // robots.txt and sitemaps are the signal
  return STATIC_ASSET.test(pathname) || STATIC_PREFIX.test(pathname);
}
