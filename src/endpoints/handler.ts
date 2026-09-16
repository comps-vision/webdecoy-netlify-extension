import { extension } from "../index";

/**
 * The extension's API handler, deployed as a Netlify Function on the host
 * project (#996).
 *
 * Installing an extension on a team is a handshake: Netlify's installer
 * POSTs to this host at /.netlify/functions/handler/on-install, and the
 * SDK's default handler completes the installation with Netlify's API.
 * The SDK does not emit this function on its own; without it the installer
 * answers a bare 500 and the extension can never be installed. This file
 * exists so the handshake has somewhere to land. No custom install logic:
 * the extension keeps no team or site state.
 */
export const handler = extension.baseHandler;
