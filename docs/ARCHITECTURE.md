# CreatorJobs — Architecture & Schema Design

Whop Technical CSM take-home. This document is the entity/state-transition review that gates
schema and migration work (see AGENTS.md guardrails).

Grounded against docs.whop.com as of 2026-08-16 (versioned "Whop API", pinned via
`Api-Version-Date`; the docs' Experimental/beta endpoints). Base URL is set by
`WHOP_API_URL` (sandbox: `https://sandbox-api.whop.com/api/v1`).

## 1. Whop integration model

**Our database is authoritative** for users, seller profiles, listings, orders, submissions,
local state transitions, idempotency records, and webhook event history. Whop objects are
referenced by ID + metadata; they never replace local records.

| CreatorJobs concept | Whop concept |
|---|---|
| Platform (CreatorJobs) | Our company (`WHOP_COMPANY_ID`), Company API key |
| Seller | **Connected account**: child company via `companies.create({ parent_company_id, email, title, metadata: { seller_id } })` → `biz_…` |
| Seller KYC / payout setup | `accountLinks.create({ company_id, use_case: "account_onboarding", return_url, refresh_url })` → hosted KYC; readiness tracked via verifications + payout methods |
| Buyer | Plain Whop user/member (captured from payment). No connected account — only payout recipients need one |
| Listing price | Inline one-time plan inside a checkout configuration |
| Buyer checkout | `checkoutConfigurations.create({ plan: { initial_price, plan_type: "one_time" }, metadata: { order_id } })` → redirect to `purchase_url`. Payments created from the session **inherit the metadata**, which is how webhooks map back to our order |
| Payment confirmation | `payment.succeeded` webhook (Standard Webhooks spec, verified via `whopsdk.webhooks.unwrap(rawBody, { headers })`) |
| Seller payout | `transfers.create({ amount, currency, origin_id: platform, destination_id: seller_biz, metadata: { order_id, payout_id } })` |

### Money flow decision: platform-collects + transfer (escrow-style)

Buyer pays the **platform** company at checkout; funds are transferred to the seller's
connected account only when the order completes. Chosen because:

- The marketplace has a real work lifecycle (paid → work → delivery → approval). Payout must
  wait for completion, and transfers put payout timing/amount under backend control.
- It exercises more of the surface the take-home asks about (order state, payout setup,
  reconciliation) than a fire-and-forget direct charge.

Trade-off (documented for the customer): with transfers, the platform is merchant of record —
platform pays Whop fees and owns refunds/disputes. The alternative is **direct charges**
(checkout configuration created with `company_id` = seller's biz + `application_fee_amount`),
where the seller owns fees/disputes and money lands with them instantly. That fits
marketplaces with instant fulfillment, not milestone work.

Sandbox caveats to verify during build:
- Transfers require the **origin** company to be KYC-verified with sufficient balance
  (top up via dashboard or the topups endpoint).
- Transfer webhook coverage is unclear in the docs index (no obvious `transfer.*` events);
  plan is to poll transfer status after creation and treat webhook confirmation as a bonus.
  Note as a Stable/Experimental gap in the submission if it holds.

## 2. Order state machine

```
pending_payment ──payment.succeeded──▶ paid ──seller accepts──▶ in_progress
      │                                 │
      │ payment.failed / expired        └──(refund.created)──▶ refunded
      ▼
   canceled

in_progress ──seller submits──▶ delivered ──buyer approves──▶ completed
                                    │
                                    └──buyer rejects──▶ in_progress (rework)

completed ──transfer created──▶ payout_pending ──transfer succeeded──▶ paid_out
                                     │
                                     └──transfer failed──▶ payout_failed (retry after fix)
```

Rules:
- Transitions are enforced by a whitelist map + conditional UPDATE
  (`UPDATE orders SET status='paid' WHERE id=$1 AND status='pending_payment'`; zero rows
  affected = out-of-order/duplicate event → log to `order_events` as a no-op, never error).
- Webhooks only move states forward. A late `payment.pending` after `paid` is ignored.
- Every transition (including rejected ones) is appended to `order_events` for the
  reconciliation/audit story.

## 3. Schema (Postgres / Supabase)

Nine tables. `*_cents` integer money, text+CHECK for enums (cheap to evolve), `timestamptz`.

```sql
-- 1. users: both roles; auth is out of scope for the prototype (email-identified)
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  display_name  text not null,
  role          text not null check (role in ('buyer','seller','admin')),
  whop_user_id  text unique,              -- user_… captured from payments
  created_at    timestamptz not null default now()
);

-- 2. seller_profiles: connected-account linkage + payout readiness
create table seller_profiles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references users(id),
  whop_company_id     text unique,        -- biz_… (child company)
  onboarding_status   text not null default 'created' check (onboarding_status in
                        ('created','link_sent','kyc_pending','verified','payout_ready','blocked')),
  has_payout_method   boolean not null default false,
  last_account_link_url text,             -- account links expire; regenerate on demand
  metadata            jsonb not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- 3. listings
create table listings (
  id           uuid primary key default gen_random_uuid(),
  seller_id    uuid not null references seller_profiles(id),
  title        text not null,
  description  text not null default '',
  price_cents  integer not null check (price_cents > 0),
  currency     text not null default 'usd',
  status       text not null default 'active' check (status in ('draft','active','archived')),
  created_at   timestamptz not null default now()
);

-- 4. orders: the spine. seller_id denormalized for dashboard queries.
create table orders (
  id                      uuid primary key default gen_random_uuid(),
  listing_id              uuid not null references listings(id),
  buyer_id                uuid not null references users(id),
  seller_id               uuid not null references seller_profiles(id),
  amount_cents            integer not null,
  currency                text not null default 'usd',
  status                  text not null default 'pending_payment' check (status in
                            ('pending_payment','paid','in_progress','delivered','completed',
                             'payout_pending','paid_out','payout_failed','canceled','refunded')),
  whop_checkout_config_id text unique,    -- ch_… / checkout configuration id
  whop_payment_id         text unique,    -- pay_…; UNIQUE = idempotent payment mapping
  paid_at                 timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index on orders (status);
create index on orders (seller_id, status);

-- 5. submissions: seller deliverables per order
create table submissions (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id),
  seller_id   uuid not null references seller_profiles(id),
  content_url text,
  note        text,
  status      text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  created_at  timestamptz not null default now()
);

-- 6. payouts: one per order (unique). idempotency_key sent as Idempotency-Key
--    header on transfers.create so a retry can never double-pay.
create table payouts (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null unique references orders(id),
  seller_id         uuid not null references seller_profiles(id),
  amount_cents      integer not null,
  currency          text not null default 'usd',
  whop_transfer_id  text unique,
  idempotency_key   uuid not null unique default gen_random_uuid(),
  status            text not null default 'pending' check (status in
                      ('pending','processing','succeeded','failed')),
  failure_reason    text,
  created_at        timestamptz not null default now(),
  settled_at        timestamptz
);

-- 7. webhook_events: persist-then-process inbox. UNIQUE whop_event_id is the
--    dedup gate (Whop retries + replay keep the same webhook-id).
create table webhook_events (
  id                uuid primary key default gen_random_uuid(),
  whop_event_id     text not null unique,   -- webhook-id header / body id (msg_…)
  event_type        text not null,          -- e.g. payment.succeeded
  api_version_date  text,
  whop_company_id   text,
  payload           jsonb not null,
  status            text not null default 'received' check (status in
                      ('received','processed','duplicate','ignored','error')),
  error             text,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz
);
create index on webhook_events (event_type, received_at desc);

-- 8. order_events: append-only audit of every attempted transition
create table order_events (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id),
  from_status       text not null,
  to_status         text not null,
  applied           boolean not null,        -- false = rejected/out-of-order, kept as evidence
  actor             text not null,           -- 'webhook' | 'buyer' | 'seller' | 'admin' | 'system'
  webhook_event_id  uuid references webhook_events(id),
  note              text,
  created_at        timestamptz not null default now()
);
create index on order_events (order_id, created_at);

-- 9. api_request_log (lightweight): outbound Whop calls for the debug/dashboard story
create table api_request_log (
  id           uuid primary key default gen_random_uuid(),
  method       text not null,
  path         text not null,
  status_code  integer,
  whop_request_id text,
  error        text,
  created_at   timestamptz not null default now()
);
```

## 4. Webhook pipeline (reliability requirements)

Endpoint: `POST /api/webhooks/whop`.

1. Read the **raw body** (never parse first), verify with `whopsdk.webhooks.unwrap` —
   Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
2. `INSERT INTO webhook_events … ON CONFLICT (whop_event_id) DO NOTHING`. Zero rows →
   duplicate/replayed delivery → mark `duplicate`, ACK 200, stop.
3. ACK 200 **before** heavy work (<5s or Whop retries); process from the stored row.
4. Handler maps event → conditional order transition (Section 2). Metadata
   (`payload.data.metadata.order_id`) is the join key back to `orders`.

Subscribed events: `payment.succeeded`, `payment.failed`, `payment.pending`,
`refund.created`, `verification.succeeded`, `payout_method.created`,
`payout_account.status_updated`, `identity_profile.updated`.

Webhook secret is returned once at webhook creation → `WHOP_WEBHOOK_SECRET`.

## 5. Ops dashboard (`/dashboard`)

Single page, reads only our DB (which is why the schema keeps evidence tables):

- **Orders**: buyer, listing, amount, order status, `whop_payment_id`, paid/completed times.
- **Sellers**: onboarding status, KYC/verification state, payout-method presence, `biz_` id.
- **Payouts**: transfer id, status, failure reason.
- **Webhook feed**: last N `webhook_events` with status + processing errors (the "is Whop
  broken or is it us" panel). Optional deep-cut: call the beta `list-deliveries` /
  `replay-delivery` endpoints for delivery-side evidence.
- **Errors**: `api_request_log` failures + `order_events` where `applied = false`.

## 6. Build order (3–4h budget)

| # | Slice | Est |
|---|---|---|
| 1 | Migrations (this schema) + `postgres` client + seed script | 30m |
| 2 | Seller onboarding: create user → connected company → account link → status page (webhook flips readiness) | 45m |
| 3 | Listings (seeded) + buyer checkout: create order (`pending_payment`) → checkout config with `metadata.order_id` → redirect to `purchase_url` | 45m |
| 4 | Webhook endpoint + inbox + state machine + `order_events` | 60m |
| 5 | Order lifecycle actions (accept/submit/approve) + payout transfer on completion | 30m |
| 6 | Dashboard | 30m |
| 7 | Deploy (Vercel + Supabase), register sandbox webhook, Loom + scenario write-ups | rest |

Deployment note: the Hono server currently uses `@hono/node-server` (long-running). For
Vercel, expose the same app through `hono/vercel` as a function entry; keep the node-server
path for local dev. Alternative if time is tight: deploy the API to a host that runs
processes (Railway/Fly) and put only the static client on Vercel — take note in README.

## 7. Experimental-API compliance notes

- Pin `Api-Version-Date` on all requests (SDK sends its version automatically — record which).
- Prefer beta/experimental endpoints (`/api-reference/beta/...`); log any forced Stable
  fallback in README per the brief (candidate: transfer status webhooks, see §1).
- All keys server-side only; sandbox keys in `.env`, never committed.
