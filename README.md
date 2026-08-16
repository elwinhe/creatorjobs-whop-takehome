# CreatorJobs

CreatorJobs is a two-sided marketplace prototype for the Whop Technical CSM take-home. Buyers hire creators, creators deliver work, and the platform releases funds only after approval. The operator view reconciles local order state, seller readiness, payouts, webhook deliveries, and failures without calling Whop.

The product contract is [`docs/PRD.md`](docs/PRD.md); the authoritative schema and state machine are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Stack

- React 19, TypeScript, Vite 8, and Tailwind CSS 4
- Hono, with an import-safe app shared by Node/Bun and Vercel
- Postgres via `postgres` (Porsager)
- `@whop/sdk` `0.0.42`, sandbox by default, API version date pinned to `2026-07-20`
- Bun for package management, scripts, and tests

## Local setup

```bash
bun install
cp .env.example .env.local
```

Fill `.env.local` with isolated sandbox credentials. Vite and Bun load local environment files; never commit them.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `APP_BASE_URL` | yes | Browser origin used for checkout and account-link redirects |
| `PORT` | no | Local API port; defaults to `3001` |
| `NODE_ENV` | no | `development`, `test`, or `production` |
| `WHOP_API_URL` | yes | Sandbox default: `https://sandbox-api.whop.com/api/v1` |
| `WHOP_API_KEY` | yes | Server-only platform company API key |
| `WHOP_COMPANY_ID` | yes | Platform company (`biz_…`) and transfer origin |
| `WHOP_WEBHOOK_SECRET` | yes | Raw secret copied from webhook registration |
| `WHOP_API_VERSION` | no | Pinned date; defaults to `2026-07-20` |

Environment validation is strict when the runtime starts. Tests receive non-secret local defaults and inject fake Whop/database boundaries, so `bun test` needs no credentials.

## Database setup

Inspect [`db/migrations/001_init.sql`](db/migrations/001_init.sql) before applying it to a new isolated database. The migration runner uses `_migrations`, checks SHA-256 drift, takes a Postgres advisory lock, and applies each new file transactionally. It never drops or resets data.

```bash
bun run migrate
bun run seed
```

The deterministic seed inserts one admin, two buyers, two sellers/profiles, and three listings. Both commands are safe to rerun: applied migrations are skipped and seed conflicts are no-ops.

## Run and validate

```bash
bun run dev       # client :5173 and API :3001
bun run lint
bun run typecheck
bun test
bun run build
```

Useful routes:

- `/` — active listings and buyer checkout
- `/seller` — seller creation, connected-account status, and resumable KYC link
- `/orders/:id` — polling order status and lifecycle actions
- `/dashboard` — five local-evidence panels plus account-link regeneration
- `/api/health` — database ping (`{ ok, db }`)

## Architecture and money flow

Postgres is authoritative for all marketplace entities and transitions. A listing price and seller are loaded inside the order transaction; the browser cannot supply either payout values or state. Checkout metadata contains the local `order_id`, which joins a verified `payment.succeeded` delivery back to the order.

```text
listing → local order (price snapshot) → Whop checkout
       → verified payment webhook → paid → in progress → delivered
       → buyer approval → one local payout intent → Whop transfer → paid out
```

All outbound Whop SDK operations pass through one gateway and write `api_request_log`, including HTTP status, request ID when supplied, and failure text. Seller links may be regenerated safely. Checkout and transfer calls use stable idempotency keys; `payouts.order_id` is unique and the payout row is created under an order lock before the network call.

The transfer path records `completed → payout_pending`, retrieves the created transfer for reconciliation, then records `paid_out`. Whop’s current transfer object has no asynchronous status field and no documented `transfer.*` webhook; a failed create/retrieve is captured as both a failed payout and `payout_failed` order transition.

## Reliability scenarios

### Duplicate webhook delivery

The endpoint reads the raw body, verifies the Standard Webhooks signature with the Whop SDK, then inserts the verified event using unique `whop_event_id`. A replay updates the existing inbox evidence to `duplicate`, acknowledges `200`, and schedules no processor. No second applied `order_events` row can be created.

### Tampered signature

Verification occurs before JSON is trusted or a database write is attempted. A changed body with the original signature receives `401`; neither `webhook_events` nor order state changes. The automated test signs the original payload with the installed Standard Webhooks implementation and verifies this failure path through the real SDK verifier.

### Out-of-order state

Every transition locks the order and compares the current state with an explicit allowlist. A late `payment.pending` after `paid` leaves the order unchanged and appends an `order_events` attempt with `applied = false`. This evidence appears in the dashboard Errors panel.

### Double approval or transfer retry

Approval and payout-intent creation are one transaction. The unique order payout is returned on repeat approval, but its persisted status/transfer ID prevents a second transfer call. The same persisted UUID is sent as Whop’s `Idempotency-Key` and ledger `idempotence_key`, so a transport-level retry is also double-pay resistant.

### Upstream failure

Seller, checkout, and payout calls preserve the local seller/order/payout record when Whop rejects a request. The API returns a useful `502`, `api_request_log` captures the upstream evidence, payout failure stores the reason, and the dashboard can answer whether the failure was local state, a rejected transition, or Whop.

## Whop API compliance

Implementation was checked against current official Whop documentation and the installed SDK types:

- [Connected-account enrollment](https://docs.whop.com/developer/platforms/enroll-connected-accounts) — child company plus hosted onboarding link
- [Checkout configurations](https://docs.whop.com/api-reference/checkout-configurations/checkout-configuration) — inline one-time plan, inherited metadata, purchase and redirect URLs
- [Webhooks](https://docs.whop.com/developer/guides/webhooks) — Standard Webhooks signature verification and fast acknowledgement
- [Manual connected-account payouts](https://docs.whop.com/developer/platforms/manual-payouts) — KYC/payout-method prerequisites and platform balance

The SDK sends the pinned `Api-Version-Date` automatically. Current Experimental/beta surfaces are isolated behind the gateway. Transfer polling/retrieval is the documented fallback because no `transfer.*` event is present in the current SDK webhook union. No Stable REST fallback is currently needed.

## Vercel deployment readiness

[`api/index.ts`](api/index.ts) exposes the same Hono app through `hono/vercel`; [`server/index.ts`](server/index.ts) retains the local Node/Bun listener and starts only when executed directly. [`vercel.json`](vercel.json) builds the Vite client, routes `/api/*` to the function, and serves the SPA for browser routes.

Before deploying:

1. Add every server environment variable to the Vercel project.
2. Run migration and seed commands against the reviewed isolated hosted database.
3. Verify the platform sandbox company is KYC-ready and has enough balance.
4. Register `https://<deployment>/api/webhooks/whop` for the event set in Architecture §4, then store the returned secret once.
5. Run checkout, replay, tamper, out-of-order, and payout scenarios against the deployed endpoint.

No live deployment, database migration, webhook registration, sandbox checkout, or transfer result is claimed by this repository state; those gates require external credentials and operator review.

## Design system

Visual constants live in `src/styles/tokens.css`, shared controls in `src/components/ui`, and route-specific composition in `src/screens`:

```text
tokens → primitives → marketplace / onboarding / order / dashboard screens
```

The UI preserves the cool canvas, near-black system rail, and orange action/status accent. Interactive targets are at least 40px, focus is visible, numbers are tabular, animations use interruptible property-specific transitions, and reduced-motion preferences are honored.
