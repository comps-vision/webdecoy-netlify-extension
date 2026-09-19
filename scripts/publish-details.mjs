#!/usr/bin/env node
/**
 * Publish details.md with the extension's host project (#1185).
 *
 * Netlify's public page for an extension renders `details.md` from the root
 * of the host project's published output: `.ntli/site/static`, the `publish`
 * directory in netlify.toml, which is where the SDK's own build writes it.
 * But `netlify-extension build` copies it there only when extension.yaml
 * declares a `ui:` block (@netlify/sdk dist/cli/commands/build.js: the copy
 * sits inside the UI branch, next to "No Extension UI configuration found.
 * Skipping UI build..."). This extension has no UI, so from its first publish
 * the host served manifest.json and packages/buildhooks.tgz, answered 404 for
 * /details.md, and the install page read "No details found for this
 * extension".
 *
 * An empty `ui:` block would make the SDK copy the file, and would also make
 * it run a nested `netlify build` of this project from inside its own build.
 * So the copy happens here, after the SDK build, and is checked: a build that
 * would publish no details fails, and a failed build on the host project
 * leaves Netlify serving the previous deploy instead of a blank page.
 *
 *   node scripts/publish-details.mjs [extension root]
 */
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const source = join(root, 'details.md');
const publishDir = join(root, '.ntli', 'site', 'static');
const published = join(publishDir, 'details.md');

function fail(message) {
  console.error(`publish-details: ${message}`);
  process.exit(1);
}

if (!existsSync(source)) {
  fail(`no details.md at ${source}; the extension's install page would be blank`);
}
const text = readFileSync(source, 'utf8');
// A heading and some prose, not a placeholder: the page renders whatever is here.
if (!/^# \S/m.test(text) || text.trim().length < 200) {
  fail(`${source} has no heading or almost no content; the install page would say next to nothing`);
}
if (!existsSync(join(publishDir, 'manifest.json'))) {
  fail(`${publishDir} has no manifest.json; run \`netlify-extension build -a\` first`);
}

copyFileSync(source, published);
if (readFileSync(published, 'utf8') !== text) {
  fail(`${published} does not match ${source} after the copy`);
}
console.log(`publish-details: wrote ${published} (${text.length} bytes)`);
