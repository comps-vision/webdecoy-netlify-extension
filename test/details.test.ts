import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The extension's public install page (#1185). Netlify renders it from
 * details.md at the root of the host's published output, and the SDK only
 * puts it there for extensions with a UI, so scripts/publish-details.mjs
 * does. These tests hold the script to failing rather than publishing a
 * blank page, and the text to saying what the docs page says.
 */

const here = new URL('.', import.meta.url).pathname;
const extensionRoot = join(here, '..');
const script = join(extensionRoot, 'scripts', 'publish-details.mjs');
const details = readFileSync(join(extensionRoot, 'details.md'), 'utf8');
// The monorepo's docs page. The Netlify deploy mirror carries this directory
// only, and runs the build, not these tests.
const docsPage = join(extensionRoot, '..', '..', 'docs-site', 'src', 'content', 'docs', 'installation', 'netlify.mdx');

/** A scratch extension root, as `netlify-extension build -a` leaves it. */
function scratchRoot(opts: { details?: string; built?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'wd-netlify-details-'));
  if (opts.details !== undefined) writeFileSync(join(root, 'details.md'), opts.details);
  if (opts.built !== false) {
    mkdirSync(join(root, '.ntli', 'site', 'static'), { recursive: true });
    writeFileSync(join(root, '.ntli', 'site', 'static', 'manifest.json'), '{}');
  }
  return root;
}

function publish(root: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(process.execPath, [script, root], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stderr?: string };
    return { ok: false, output: e.stderr ?? '' };
  }
}

describe('publish-details', () => {
  it('puts details.md at the root of the published output, byte for byte', () => {
    const root = scratchRoot({ details });
    expect(publish(root).ok).toBe(true);
    expect(readFileSync(join(root, '.ntli', 'site', 'static', 'details.md'), 'utf8')).toBe(details);
  });

  it('fails the build when there is no details.md', () => {
    const root = scratchRoot({});
    const result = publish(root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('no details.md');
    expect(existsSync(join(root, '.ntli', 'site', 'static', 'details.md'))).toBe(false);
  });

  it('fails the build on a details.md with nothing in it', () => {
    expect(publish(scratchRoot({ details: '' })).ok).toBe(false);
    expect(publish(scratchRoot({ details: 'TODO\n' })).ok).toBe(false);
  });

  it('fails when the SDK build has not produced the published output', () => {
    const result = publish(scratchRoot({ details, built: false }));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('netlify-extension build');
  });
});

describe('details.md', () => {
  it('says what the extension does, and what it does not do unless asked', () => {
    expect(details).toMatch(/^# WebDecoy Crawler Sensor$/m);
    expect(details).toContain('## What it never does without you');
    expect(details).toContain('never blocks');
    // It must not promise monitoring-only now that a site can opt into the
    // gate, and it must not promise the gate to a site that has not (#1188).
    expect(details).not.toMatch(/monitoring only/i);
    expect(details).toContain('WEBDECOY_ENFORCEMENT');
    expect(details).toContain('off unless you add a fourth variable');
  });

  it.skipIf(!existsSync(docsPage))('names the same environment variables as the docs page', () => {
    const names = (text: string) => [...new Set(text.match(/WEBDECOY_[A-Z_]+/g) ?? [])].sort();
    expect(names(details)).toEqual(names(readFileSync(docsPage, 'utf8')));
    // The three the sensor needs, and the one that turns the gate on (#1188).
    expect(names(details)).toEqual([
      'WEBDECOY_ENFORCEMENT',
      'WEBDECOY_SCANNER_ID',
      'WEBDECOY_SENSOR_KEY',
      'WEBDECOY_SITE_KEY',
    ]);
  });

  it('has no em-dashes (customer-facing copy)', () => {
    expect(details).not.toContain('—');
  });
});
