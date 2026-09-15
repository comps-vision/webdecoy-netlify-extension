import { NetlifyExtension } from "@netlify/sdk";

/**
 * WebDecoy Crawler Sensor for Netlify (#996).
 *
 * The extension installs on a team, but a sensor that reports every site
 * on the team the moment someone installs it would be the wrong default:
 * only a site that has been given its WebDecoy identity opts in. That
 * identity is three environment variables on the site, the same values the
 * Cloudflare Worker is deployed with (site key, scanner id, sensor key), so
 * a Netlify site and a Worker on the same property report as the same
 * scanner and ingest cannot tell them apart by construction.
 *
 * Injection happens at build time. The site's env is present in the build,
 * so the gate is read here; the function then reads the same variables at
 * request time through Netlify.env. Nothing is injected into a site that
 * has not set them, and removing them plus one deploy removes the sensor.
 */
const extension = new NetlifyExtension();

extension.addEdgeFunctions("./src/edge-functions", {
  prefix: "webdecoy",
  shouldInjectFunction: () =>
    !!process.env.WEBDECOY_SITE_KEY && !!process.env.WEBDECOY_SCANNER_ID,
});

export { extension };
