# Dashboard

Operator view for the MCP Relay Harness gateway. React 19, Tailwind v4, Vite.

## Views

- **Live Fan-out**: connects real WebSocket subscribers directly from the browser to the gateway's `/subscribe` endpoint, and renders the actual topology (origin, relay, each subscriber) and per-subscriber message stream and latency, not a simulated one.
- **Gap Audit**: polls the gateway's delivery-log endpoints for true per-type totals (`/api/delivery-log/counts`), gap causes, and a recent throughput trend, so an operator can see every gap marker the relay has ever issued for a feed and why.

## Running locally

```bash
npm install
npm run dev
```

Requires a running gateway (see the root `README.md`). On first load, open Settings and confirm the gateway URL and token match your local `wrangler dev` instance (defaults match the documented dev-only values in `apps/gateway/wrangler.toml`).

Connection settings persist in the browser's own `localStorage`, never baked into the built bundle. This is a static site; embedding a bearer token in the build would ship it to anyone who opens devtools.

## Scripts

- `npm run dev`: start the Vite dev server
- `npm run build`: type-check (`tsc -b`) and build for production
- `npm run lint`: `oxlint`
