import { readFileSync } from "node:fs";
import path from "node:path";
import { extension } from "../index";

/**
 * The extension's API handler, deployed as a Netlify Function on the host
 * project (#996).
 *
 * Installing an extension on a team is a handshake: Netlify's installer
 * POSTs to this host at /.netlify/functions/handler/on-install, and the
 * SDK's default handler completes the installation against Netlify's
 * extension API. The SDK does not emit this function on its own; without it
 * the installer answers a bare 500.
 *
 * The SDK writes the extension's slug into the build-time bundle it
 * generates, but nothing sets it for this function, and the default install
 * handler then posts to `/team/<team>/integrations//installation`: an empty
 * slug, which Netlify's API rejects with a 500 (seen in the host's function
 * log on 2026-09-15). The slug has one home, extension.yaml, so it is read
 * from there. netlify.toml ships the file with the function.
 */
function slugFromManifest(): string {
  for (const candidate of [
    path.join(process.cwd(), "extension.yaml"),
    path.join(process.cwd(), "..", "extension.yaml"),
  ]) {
    try {
      const match = /^\s*slug:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m.exec(readFileSync(candidate, "utf8"));
      if (match) return match[1];
    } catch {
      // try the next location
    }
  }
  return process.env.WEBDECOY_EXTENSION_SLUG ?? "";
}

const slug = slugFromManifest();
if (!slug) {
  console.error("[webdecoy] extension slug not found: extension.yaml was not shipped with the function and WEBDECOY_EXTENSION_SLUG is unset; installs will fail");
}
(extension as unknown as { _slug: string })._slug = slug;

export const handler = extension.baseHandler;
