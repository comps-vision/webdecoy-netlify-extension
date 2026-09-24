/**
 * What a Netlify validator applies, declared on every report (#1124, #1187).
 *
 * The same list the Cloudflare Worker declares, because both run the same
 * decision from the same files (#1188), plus one name the Worker does not:
 *
 *   bot_verification_rdns  this validator verifies crawlers itself, by
 *                          forward-confirmed reverse DNS for the operators
 *                          that publish it and by Web Bot Auth signatures.
 *                          It has no platform verified-bot categories, so a
 *                          bot that is neither is not exempt here however the
 *                          site's exemptions are set.
 *
 * The dashboard reads that name to stop a site's exemption controls claiming
 * coverage this validator cannot deliver. `validatorsupport.Known` in the
 * backend lists every name here, and a Go test reads this file.
 */
export const NETLIFY_VALIDATOR_CAPABILITIES: readonly string[] = [
  'route_min_trust',
  'route_attribution',
  'monitor_routes',
  'route_exceptions',
  'bot_behaviors',
  'credential_reach',
  'bot_verification_rdns',
  'crawler_behavior',
  'ai_referrals',
];
