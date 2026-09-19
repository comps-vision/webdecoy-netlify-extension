# WebDecoy Netlify extension (#996)

An injected edge function that reports automated traffic on a Netlify site to WebDecoy, and — for a site that sets `WEBDECOY_ENFORCEMENT` — is also WebDecoy's clearance validator (#1188). Without that variable it reports and changes no response. See `docs/NETLIFY_EXTENSION.md` in the repository root for the spike record, and `details.md` for the customer-facing text.

The gate is not written here: `src/sensor/gate.ts` composes the Cloudflare Worker's own modules (`decision.ts`, `validator-parts.ts`, `telemetry.ts`) and the AWS validator's reverse-DNS table, which the bundler pulls into the single injected file. A change to any of those re-runs this package's CI.

```
npm ci
npm run gen:agents      # regenerate src/sensor/agents.generated.ts from pkg/agents
npm run build:bundle    # src/sensor -> src/edge-functions/webdecoy-sensor.ts (committed)
npm test
npm run typecheck
npm run build           # netlify-extension build -a (the buildtime component), then publish details.md
```

Publishing: this directory is deployed as its own Netlify project (see `netlify.toml`); the extension is then created in the Netlify UI, which assigns the slug to put in `extension.yaml`. Private to the team until made public.

`details.md` is the extension's public install page. Netlify reads it from the host's published output (`.ntli/site/static`), which the SDK only writes for extensions with a UI, so `scripts/publish-details.mjs` puts it there and fails the build without it (#1185).
