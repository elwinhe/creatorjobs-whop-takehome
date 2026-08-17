# CreatorJobs

CreatorJobs is a two-sided marketplace prototype for the Whop Technical CSM take-home. Buyers hire creators, creators deliver work, and the platform releases funds only after approval. The operator view reconciles local order state, seller readiness, payouts, webhook deliveries, and failures without calling Whop.

The authoritative schema and state machine are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and completed checks and remaining gaps are recorded in [`docs/VALIDATION.md`](docs/VALIDATION.md).

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

Environment validation is strict for every required integration value when the server runtime starts. The migration and seed commands intentionally validate only `DATABASE_URL`; they do not require unrelated Whop configuration. Tests receive non-secret local defaults and inject fake Whop/database boundaries, so `bun test` needs no credentials.

## Database setup

Inspect [`db/migrations/001_init.sql`](db/migrations/001_init.sql) before applying it to a new isolated database. The migration runner uses `_migrations`, checks SHA-256 drift, takes a Postgres advisory lock, and applies each new file transactionally. It never drops or resets data.

```bash
bun run migrate
bun run seed
```

The deterministic seed inserts one admin, two buyers, two sellers/profiles, and three listings. Both commands are safe to rerun: applied migrations are skipped and seed conflicts are no-ops. Database health passed against the isolated hosted Postgres database. Migration and seed passed twice there, with final counts `users=5`, `seller_profiles=2`, `listings=3`, and every other marketplace/evidence table at `0`.

## Run and validate

```bash
bun run dev       # client :5173 and API :3001
bun run lint
bun run typecheck
bun test
bun run build
```

Vercel discovers the committed `api/index.js` function before running the frontend build. It is generated from the shared server runtime and must not be edited by hand. The normal `bun run build` regenerates it before typechecking and building the frontend. After any server runtime change, run the packaging test to detect drift:

```bash
bun run build:vercel-handler
bun test server/vercel.test.ts
```

Useful routes:

- `/` — active listings and buyer checkout
- `/seller` — seller creation, connected-account status, resumable KYC, and hosted payout-method management
- `/orders/:id` — polling order status and lifecycle actions
- `/dashboard` — five local-evidence panels plus account-link regeneration
- `/api/health` — database ping (`{ ok, db }`)

## Architecture and money flow

Postgres is authoritative for all marketplace entities and transitions. A listing price and seller are loaded inside the order transaction; the browser cannot supply either payout values or state. Checkout metadata contains the local `order_id`, which joins a verified `payment.succeeded` delivery back to the order.

```text
listing → local order (price snapshot) → Whop checkout
       → verified payment webhook → paid → in progress → delivered
       → buyer approval → one local payout intent → Whop transfer → paid out*
```

`*` The successful-transfer path is covered by automated tests. Whop currently does not
support payouts in sandbox, so the live validation stopped at a rejected transfer and did
not reach `paid_out`.

All outbound Whop SDK operations pass through one gateway and write `api_request_log`, including HTTP status, request ID when supplied, and failure text. Hosted KYC links may be regenerated safely and are persisted only for onboarding resumption. The separate hosted payout portal uses a fresh `payouts_portal` account link on every request; its temporary URL is returned to the seller but never persisted or logged, and readiness still changes only from signed Whop webhooks. Checkout and transfer calls use stable idempotency keys. `payouts.order_id` is unique, and approval atomically changes the persisted payout from `pending` to `processing` before the network call. Only the request that acquires that database claim may call Whop; simultaneous approvals reuse the same payout but cannot both issue a transfer request.

The transfer path records `completed → payout_pending`, retrieves the created transfer for reconciliation, then records `paid_out`. Whop’s current transfer object has no asynchronous status field and no documented `transfer.*` webhook; a failed create/retrieve is captured as both a failed payout and `payout_failed` order transition.

## Reliability scenarios

### Duplicate webhook delivery

The endpoint reads the raw body, verifies the Standard Webhooks signature with the Whop SDK, then inserts the verified event using unique `whop_event_id`. A replay updates the existing inbox evidence to `duplicate`, acknowledges `200`, and schedules no processor. No second applied `order_events` row can be created.

### Tampered signature

Verification occurs before JSON is trusted or a database write is attempted. A changed body with the original signature receives `401`; neither `webhook_events` nor order state changes. The automated test signs the original payload with the installed Standard Webhooks implementation and verifies this failure path through the real SDK verifier.

### Out-of-order state

Every transition locks the order and compares the current state with an explicit allowlist. A late `payment.pending` after `paid` leaves the order unchanged and appends an `order_events` attempt with `applied = false`. This evidence appears in the dashboard Errors panel.

### Double approval or transfer retry

Approval, payout-intent creation, and transfer ownership claim are one transaction. A repeat or simultaneous approval can read the unique order payout, but only the transaction that atomically claims its persisted status may call Whop. The same persisted UUID is sent as Whop’s `Idempotency-Key` and ledger `idempotence_key`, so a transport-level retry is also double-pay resistant.

### Upstream failure

Seller, checkout, and payout calls preserve the local seller/order/payout record when Whop rejects a request. Hosted-link client responses use stable generic messages, while operational details remain in `api_request_log`. Payout failure stores the reason, and the dashboard can answer whether the failure was local state, a rejected transition, or Whop.

## Whop API compliance

Implementation was checked against current official Whop documentation and the installed SDK types:

- [Connected-account enrollment](https://docs.whop.com/developer/platforms/enroll-connected-accounts) — child company plus hosted onboarding link
- [Hosted payout portal](https://docs.whop.com/developer/platforms/render-payout-portal) — temporary `payouts_portal` account links for payout-method and withdrawal management
- [Checkout configurations](https://docs.whop.com/api-reference/checkout-configurations/checkout-configuration) — inline one-time plan, inherited metadata, purchase and redirect URLs
- [Webhooks](https://docs.whop.com/developer/guides/webhooks) — Standard Webhooks signature verification and fast acknowledgement
- [Manual connected-account payouts](https://docs.whop.com/developer/platforms/manual-payouts) — KYC/payout-method prerequisites and platform balance
- [Sandbox testing](https://docs.whop.com/developer/guides/sandbox) — environment setup and the current payout limitation

The SDK sends the pinned `Api-Version-Date` automatically. Current Experimental/beta surfaces are isolated behind the gateway. Transfer polling/retrieval is the documented fallback because no `transfer.*` event is present in the current SDK webhook union. No Stable REST fallback is currently needed.

## Vercel deployment readiness

[`server/vercel.ts`](server/vercel.ts) exposes the Hono app through `hono/vercel`; the normal build bundles it into the committed [`api/index.js`](api/index.js) Vercel function. [`vercel.json`](vercel.json) routes exact and nested `/api/*` requests to that function before applying the SPA fallback. [`server/index.ts`](server/index.ts) retains the local Node/Bun listener and starts only when executed directly.

Before deploying:

1. Add every server environment variable to the Vercel project.
2. Run migration and seed commands against the reviewed isolated hosted database.
3. Verify platform KYC readiness, but do not treat sandbox transfer success as a deployment gate: Whop documents sandbox payouts as unavailable.
4. Register `https://<deployment>/api/webhooks/whop` for the event set in Architecture §4, then store the returned secret once.
5. Run checkout, replay, tamper, and out-of-order scenarios against the deployed endpoint. Keep transfer success under automated coverage until a payout-capable environment is available.

Live validation passed seller onboarding, hosted checkout, payment confirmation, webhook reliability, and the local order lifecycle through `completed`. The live payout attempt reached Whop but was rejected because sandbox payouts are unavailable; no successful transfer or `paid_out` state is claimed. Dashboard and deployment routing contracts pass, but manual dashboard browser QA and a public Vercel deployment remain unverified. See [`docs/VALIDATION.md`](docs/VALIDATION.md) for the evidence and remaining requirements.

## Design system

Visual constants live in `src/styles/tokens.css`, shared controls in `src/components/ui`, and route-specific composition in `src/screens`:

```text
tokens → primitives → marketplace / onboarding / order / dashboard screens
```

The UI preserves the cool canvas, near-black system rail, and orange action/status accent. Interactive targets are at least 40px, focus is visible, numbers are tabular, animations use interruptible property-specific transitions, and reduced-motion preferences are honored.

## Tools and references used

Implementation and validation used official Whop documentation, the installed Whop SDK
types, OpenAI Codex, and Zo.
