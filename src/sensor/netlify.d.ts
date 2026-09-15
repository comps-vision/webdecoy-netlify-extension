/**
 * The parts of Netlify's edge runtime the sensor touches. Declared here
 * rather than imported from @netlify/edge-functions so the bundle stays a
 * single file with no package resolution at the edge (only inline
 * declarations and URL imports are allowed in injected functions).
 */
export interface NetlifyContext {
  ip: string;
  geo?: { country?: { code?: string; name?: string }; city?: string };
  site?: { id?: string; name?: string; url?: string };
  requestId?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
  next: () => Promise<Response>;
}

declare global {
  // Netlify's global for environment access at the edge.
  const Netlify: { env: { get(name: string): string | undefined } } | undefined;
}
