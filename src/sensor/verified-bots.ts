/**
 * How a Netlify validator recognises a verified crawler (#1187).
 *
 * Cloudflare hands its Worker a verified-bot category; Netlify hands us
 * nothing. The decision settled in docs/NETLIFY_EXTENSION.md §10: forward
 * confirmed reverse DNS, using the AWS validator's table rather than a second
 * copy of it, so "is this a verified search engine" has one answer across the
 * two validators that have to work it out for themselves.
 *
 * `node:dns` bundles here but its `reverse()` throws ERR_NOT_IMPLEMENTED on
 * Netlify's runtime, measured 2026-09-19. `Deno.resolveDns` does both
 * directions, IPv4 and IPv6, in 5 to 150 ms.
 *
 * What it cannot verify — crawlers that publish IP ranges and no reverse DNS,
 * and the categories Cloudflare verifies by its own means — is not guessed at.
 * Those are exempt only if they sign their requests (Web Bot Auth, which the
 * shared decision checks next), and otherwise they meet the same clearance
 * check as any other client. The build says so through its capability list.
 */

import { verifyBot, type DnsResolver } from '../../../clearance-lambda/src/verified-bots';
import { claimsCrawler } from './classify';

declare const Deno:
  | { resolveDns(query: string, recordType: string): Promise<string[]> }
  | undefined;

/** Cloudflare's word for what this recognises, so the shared decision can
 *  apply the site's exemptions to it exactly as it does on a Worker. */
const SEARCH_ENGINE_CATEGORY = 'Search Engine Crawler';

/** A lookup that takes longer than this is not worth a visitor's wait. */
const DNS_TIMEOUT_MS = 1000;

/** Every category, because the site's own exemptions are applied afterwards
 *  by the shared decision, not here. */
const VERIFY_ALL = { search_engines: true, ai_crawlers: true, monitoring: true };

/** `1.2.3.4` -> `4.3.2.1.in-addr.arpa`, and the IPv6 nibble form. */
export function reverseName(ip: string): string {
  if (!ip.includes(':')) {
    return ip.split('.').reverse().join('.') + '.in-addr.arpa';
  }
  const [headPart, tailPart = ''] = ip.split('::');
  const head = headPart ? headPart.split(':') : [];
  const tail = tailPart ? tailPart.split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return '';
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  return (
    groups
      .map((g) => g.padStart(4, '0'))
      .join('')
      .split('')
      .reverse()
      .join('.') + '.ip6.arpa'
  );
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), ms)),
  ]);
}

/** Deno's resolver behind the AWS validator's interface. */
export function denoResolver(resolve: (q: string, t: string) => Promise<string[]>): DnsResolver {
  return {
    reverse: (ip) => withTimeout(resolve(reverseName(ip), 'PTR'), DNS_TIMEOUT_MS),
    resolve4: (host) => withTimeout(resolve(host, 'A'), DNS_TIMEOUT_MS),
    resolve6: (host) => withTimeout(resolve(host, 'AAAA'), DNS_TIMEOUT_MS),
  };
}

/**
 * The platform hook the shared decision calls.
 *
 * Two gates before any DNS: the request has to claim to be a crawler, and a
 * protected path has to cover it. A browser never costs a lookup, and neither
 * does a crawler on a page nothing protects, where the verdict is `unscoped`
 * whatever the answer. Results are cached per IP by the AWS module.
 *
 * Any failure — no resolver, a timeout, a PTR that does not forward-confirm —
 * answers '' , which means "not verified" and never "verified".
 */
export function verifiedBotCategory(
  ip: string,
  userAgent: string,
  covered: boolean,
  resolve: ((q: string, t: string) => Promise<string[]>) | undefined = typeof Deno !== 'undefined' &&
  Deno &&
  typeof Deno.resolveDns === 'function'
    ? Deno.resolveDns.bind(Deno)
    : undefined,
  now: number = Date.now()
): Promise<string> {
  if (!covered || !ip || !resolve || !claimsCrawler(userAgent)) return Promise.resolve('');
  return verifyBot(ip, VERIFY_ALL, denoResolver(resolve), now)
    .then((category) => (category === 'search_engines' ? SEARCH_ENGINE_CATEGORY : ''))
    .catch(() => '');
}
