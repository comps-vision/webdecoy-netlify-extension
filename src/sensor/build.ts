/**
 * Which build of the injected function is running (#988 provenance).
 *
 * The placeholder is replaced by scripts/bundle.mjs with the hash of the
 * bundle it just produced, so every enforcement report names the build that
 * sent it and the dashboard never has to guess a version. Outside the bundle
 * — in tests, and in the unbundled source — it stays the placeholder, which
 * is honest: that code is not a shipped build.
 */
export const BUILD = '__WD_NETLIFY_BUILD__';
