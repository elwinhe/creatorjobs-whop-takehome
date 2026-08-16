# CreatorJobs — PRD & Implementation Checkpoints

Whop Technical CSM take-home. Companion to `docs/ARCHITECTURE.md` (entity model, state
machine, schema DDL — reviewed 2026-08-15). This document is the build contract: what we're
making, in what order, and the exit gate for each checkpoint.

## 1. Product summary

CreatorJobs is a two-sided marketplace prototype: buyers purchase creative services from
sellers; the platform holds funds until work is approved, then pays the seller out
(escrow-style funds flow implemented at the application layer — platform-collects +
`transfers.create` on completion; see ARCHITECTURE §1 for the trade-off vs. direct charges).

**Whop surface exercised:** connected accounts (child companies), hosted KYC via account
links, checkout configurations with metadata join-keys, Standard-Webhooks ingestion,
transfers with idempotency, sandbox environment.

### Goals (rubric-mapped)

1. **Working money flow** — checkout → paid order → delivery → approval → transfer.
2. **Reliability story** — signature verification, webhook inbox dedup, idempotent
   transitions, one-payout-per-order, double-pay-proof retries.
3. **Debuggability** — ops dashboard reading only our DB: orders, sellers, payouts,
   webhook feed, error/rejected-transition evidence.
4. **Experimental-API compliance** — version pinning recorded, Stable fallbacks documented
   (candidate: no `transfer.*` webhooks → poll).

### Non-goals

- Auth (users are email-identified rows; `role` set at creation/seed).
- KYC approval UI — KYC is Whop's hosted flow; we only observe status via webhooks.
- True moderation (suspend/delist). Schema supports it (`blocked`, `archived`) but no UI.
- Multi-currency, partial refunds, dispute handling, fees/rake (rake = 0 for the demo;
  transfer amount == order amount).

## 2. Actors & core flows

| Actor | Flow |
|---|---|
| Seller | Sign up → platform creates child company (`biz_…`) → follow account link (hosted KYC) → readiness flips via webhooks → accept order → submit deliverable → get paid out |
| Buyer | Pick listing → order created (`pending_payment`) → Whop checkout → webhook flips to `paid` → review delivery → approve |
| Admin/operator | Watch dashboard: order spine, seller readiness, payouts, webhook feed, errors. Action: regenerate expired account link (stretch: retry failed payout) |

Order state machine, transition rules, and all nine tables: ARCHITECTURE §2–3. Not
duplicated here.

## 3. Environment & config

| Var | Purpose |
|---|---|
| `WHOP_API_KEY` | Platform company API key (server-only) |
| `WHOP_COMPANY_ID` | Platform `biz_…` (transfer origin) |
| `WHOP_API_URL` | `https://sandbox-api.whop.com/api/v1` |
| `WHOP_WEBHOOK_SECRET` | From webhook registration (returned once) |
| `DATABASE_URL` | Supabase Postgres connection string |
| `APP_BASE_URL` | For account-link return/refresh URLs + checkout redirect |

`.env.example` committed with placeholders; real values ignored. All Whop calls go through
one server-side client wrapper that logs to `api_request_log`.

## 4. Implementation checkpoints

Each checkpoint ends with a **gate** — a demoable/verifiable state. Don't start the next
slice until the gate passes; if the 3–4h budget runs out, ship at the last passed gate and
write up the rest as "next steps."

---

### C0 — Repo plumbing (15m)

**Scope:** make the scaffold runnable end-to-end with env + DB client.

- Add `.env.example` (§3 vars) and `server/env.ts` zod validation for new vars.
- Add `postgres` (porsager) client in `server/db.ts`; `bun add postgres`.
- Whop SDK client factory in `server/whop.ts`: base URL from env, wraps every call with
  `api_request_log` insert (method, path, status, `whop_request_id`, error).
- `server/index.ts`: mount `/api` router skeleton + health route returning DB ping.

**Gate:** `bun run dev` boots client+server; `GET /api/health` returns `{ ok: true, db: true }`.

---

### C1 — Migrations + seed (30m)

**Scope:** the nine tables from ARCHITECTURE §3, verbatim.

- `db/migrations/001_init.sql` (single file is fine at this scale) + `bun run migrate`
  script that applies idempotently (track in a `_migrations` table).
- `db/seed.ts`: 1 admin, 2 buyers, 2 sellers (+ `seller_profiles`), 3 listings.
  Deterministic emails so demo scripts are repeatable.

**Gate:** fresh Supabase DB → `bun run migrate && bun run seed` → `select count(*)` sane on
all 9 tables; re-running both is a no-op (idempotent).

---

### C2 — Seller onboarding (45m)

**Scope:** connected account + hosted KYC loop.

API:
- `POST /api/sellers` — create user (role `seller`) + `seller_profiles` row →
  `companies.create({ parent_company_id, email, title, metadata: { seller_id } })` →
  store `whop_company_id`, status `created`.
- `POST /api/sellers/:id/account-link` — `accountLinks.create({ company_id,
  use_case: "account_onboarding", return_url, refresh_url })` → store
  `last_account_link_url`, status `link_sent`. **Re-callable** (links expire — this
  endpoint is also the admin "regenerate link" action).
- `GET /api/sellers/:id` — profile + readiness.

Webhooks (handled in C4, but statuses defined now): `verification.succeeded` → `verified`;
`payout_method.created` → `has_payout_method = true`, status `payout_ready`.

UI: minimal seller page — create seller form, "Start/Resume KYC" button (opens link),
readiness badge ladder.

**Gate:** in sandbox, a created seller has a real `biz_…` id and an account link that opens
Whop's hosted onboarding. Statuses advance after C4 lands (note dependency).

---

### C3 — Listings + checkout (45m)

**Scope:** buyer purchase path up to the redirect.

API:
- `GET /api/listings` — active listings (seeded; no listing CRUD UI).
- `POST /api/orders` — body `{ listing_id, buyer_email }`: find-or-create buyer user,
  insert order `pending_payment` (price snapshotted to `amount_cents`) →
  `checkoutConfigurations.create({ plan: { initial_price, plan_type: "one_time" },
  metadata: { order_id } })` → store `whop_checkout_config_id`, return `purchase_url`.
- `GET /api/orders/:id` — order + event history (for the post-checkout status page).

UI: listings grid → buy → redirect to `purchase_url`; return page polls `GET /api/orders/:id`.

**Gate:** sandbox checkout completes with a test payment; order row holds checkout config
id; buyer lands back on status page (still `pending_payment` until C4).

---

### C4 — Webhook pipeline + state machine (60m) ← the rubric core

**Scope:** ARCHITECTURE §4 verbatim.

- `POST /api/webhooks/whop`: raw body → `whopsdk.webhooks.unwrap` verify →
  `INSERT … ON CONFLICT (whop_event_id) DO NOTHING` inbox → ACK 200 fast → process stored row.
- Transition map + conditional-UPDATE applier; every attempt (applied or rejected) appended
  to `order_events` with `webhook_event_id` link.
- Handlers: `payment.succeeded` (join via `metadata.order_id`; backfill `users.whop_user_id`,
  set `paid_at`), `payment.failed`, `refund.created`, `verification.succeeded`,
  `payout_method.created`, `payout_account.status_updated`.
- Register sandbox webhook (all above events) → capture `WHOP_WEBHOOK_SECRET`.

**Gate (test these explicitly, they're the demo):**
1. Real checkout → order flips `pending_payment → paid`.
2. Replay the same delivery (Whop replay endpoint or curl with same headers) → inbox row
   marked `duplicate`, no second transition, `order_events` shows nothing new applied.
3. Tampered signature → 401, nothing persisted.
4. Out-of-order event (e.g. `payment.pending` after `paid`) → `order_events` row with
   `applied = false`.

---

### C5 — Lifecycle actions + payout (30m)

**Scope:** work loop + the escrow release.

API (all conditional UPDATEs + `order_events`, actor = `seller`/`buyer`):
- `POST /api/orders/:id/accept` — `paid → in_progress`.
- `POST /api/orders/:id/submit` — `{ content_url, note }` → `submissions` row +
  `in_progress → delivered`.
- `POST /api/orders/:id/approve` — `delivered → completed` (+ `completed_at`, submission
  `approved`) → **payout**: insert `payouts` row (UNIQUE `order_id` — insert-or-noop) →
  `transfers.create` with stored `idempotency_key` as `Idempotency-Key` header, origin
  platform, destination seller `biz_…`, `metadata: { order_id, payout_id }` →
  `completed → payout_pending` → poll transfer status (no `transfer.*` webhooks per docs;
  recorded compliance note) → `paid_out` or `payout_failed` + `failure_reason`.
- `POST /api/orders/:id/reject` — `delivered → in_progress`, submission `rejected` (rework).

UI: order detail page with role-appropriate action buttons.

**Gate:** full happy path in sandbox — checkout → accept → submit → approve → transfer
visible in Whop sandbox dashboard, order `paid_out`, exactly one `payouts` row. Calling
approve twice creates no second transfer (idempotency demo).

**Prereq check:** platform sandbox company must be KYC-verified with balance (top up via
dashboard/topups endpoint) — do this during C2 wait time, not now.

---

### C6 — Ops dashboard (30m)

**Scope:** ARCHITECTURE §5. Single `/dashboard` page, reads only our DB.

- Panels: Orders (spine + `whop_payment_id`), Sellers (readiness ladder + `biz_` id),
  Payouts (transfer id/status/failure), Webhook feed (last 50 + status/error), Errors
  (`api_request_log` failures + `order_events` where `applied = false`).
- One admin action wired: **Regenerate account link** (reuses C2 endpoint).
- Stretch only if ahead of budget: **Retry payout** button (re-calls transfer with stored
  `idempotency_key` — live double-pay-proof demo).

**Gate:** after the C4 test sequence, dashboard visibly shows: the duplicate inbox row, the
rejected transition, and the completed payout — no Whop API calls needed to explain state.

---

### C7 — Deploy + submission (rest of budget)

- Supabase: migrations + seed against hosted DB.
- Vercel: `hono/vercel` function entry alongside the node-server dev path (ARCHITECTURE §6
  note); static client on Vercel. Fallback if fighting the platform: Railway/Fly for API,
  note in README.
- Point sandbox webhook at deployed URL; re-run C4 gate tests once against prod.
- README: setup, env table, architecture summary link, **scenario write-ups** (brief's
  debugging scenarios), Experimental-API compliance notes (version pinned, transfer-webhook
  gap + polling fallback), Loom.

**Gate:** cold visitor can run the demo from the README; C4 reliability tests pass against
the deployed endpoint.

---

## 5. Cut lines (if budget collapses)

In order of what to drop: C6 stretch (retry button) → C6 becomes JSON-dump-with-headings →
C5 reject/rework path → C2 UI polish (curl + status page only). **Never cut:** C4 gates —
the webhook reliability behavior is the rubric's center of gravity — and the README
scenario write-ups.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Sandbox transfers blocked (origin KYC/balance) | Verify platform company readiness during C2; topups endpoint; if hard-blocked, demo payout as far as `transfers.create` error and show `payout_failed` + retry path — still exercises the schema |
| No `transfer.*` webhooks | Poll after create (C5); documented as Experimental gap |
| Account link expiry mid-demo | Regenerate endpoint exists from C2; wired to dashboard in C6 |
| Vercel + long-running Hono friction | `hono/vercel` entry; Railway fallback pre-authorized in ARCHITECTURE §6 |
| Webhook 5s ACK budget | Persist-then-process; heavy work after 200 |
