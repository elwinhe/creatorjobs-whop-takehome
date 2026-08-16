# Live gate status and remaining checks

The hosted database checks and credential-free contracts have passed. Whop sandbox and Vercel
credentials were unavailable, so no live Whop or deployment result is claimed. Keep any future
credentials in an ignored `.env.local`; never paste them into commands or commit them.

| Gate | Evidence status |
| --- | --- |
| C0 | Passed: `/api/health` reported database health against the isolated hosted Postgres database. |
| C1 | Passed twice: migration and seed reran idempotently; counts were `users=5`, `seller_profiles=2`, `listings=3`, and `orders`, `submissions`, `payouts`, `webhook_events`, `order_events`, `api_request_log` all `0`. |
| C2 | Automated contract passes; live connected account, real `biz_…` ID, and hosted KYC link unverified. |
| C3 | Automated contract passes; live hosted checkout unverified. |
| C4 | Automated signature, duplicate, and out-of-order contracts pass; live webhook registration and deliveries unverified. |
| C5 | Automated lifecycle, failure-evidence, and concurrent payout-claim contracts pass; live transfer unverified. |
| C6 | Automated database-only dashboard contract passes. |
| C7 | Vercel routing/build contracts pass; deployment remains unverified. |

## C0 — hosted database health (passed)

The health endpoint passed against the intended isolated hosted database. For a future
environment recheck:

1. Copy `.env.example` to `.env.local` and fill all required values with sandbox/isolated
   resources. Keep `WHOP_API_VERSION=2026-07-20`.
2. Run `bun run dev`.
3. Run `curl --fail --silent http://localhost:3001/api/health`. Confirm `ok` and `db` are
   both `true`; stop if the database is not the intended isolated instance.

## C1 — hosted Postgres migration and seed (passed twice)

The migration and deterministic seed completed twice. The verified counts were `5, 2, 3,
0, 0, 0, 0, 0, 0` in the query order below. For a future rerun:

1. Export the values from `.env.local` into the shell used for the commands.
2. Run `bun run migrate && bun run seed` against a fresh Supabase Postgres database.
3. Run both commands a second time. The migration must print `skip 001_init.sql`; the seed
   must complete without adding rows.
4. In the Supabase SQL editor, verify these counts:

   ```sql
   select 'users' as table_name, count(*) from users
   union all select 'seller_profiles', count(*) from seller_profiles
   union all select 'listings', count(*) from listings
   union all select 'orders', count(*) from orders
   union all select 'submissions', count(*) from submissions
   union all select 'payouts', count(*) from payouts
   union all select 'webhook_events', count(*) from webhook_events
   union all select 'order_events', count(*) from order_events
   union all select 'api_request_log', count(*) from api_request_log;
   ```

   The fresh seeded counts must be `5, 2, 3, 0, 0, 0, 0, 0, 0` in that order.

## C2 — connected seller and hosted onboarding

1. Open `http://localhost:5173/seller`, create a unique sandbox seller, and confirm the
   resulting profile contains a real `biz_...` Whop company ID.
2. Select **Start / resume KYC**. Confirm the returned Whop URL opens hosted onboarding for
   that connected company.
3. Generate a second link with `POST /api/sellers/<seller-uuid>/account-link`; confirm it
   succeeds and replaces `last_account_link_url` rather than creating another seller.
4. Complete sandbox identity verification and add a payout method after C4 webhook
   registration. Confirm `GET /api/sellers/<seller-uuid>` progresses to `verified`, then
   `payout_ready` with `has_payout_method=true`.

## C3 — hosted checkout

1. Open `http://localhost:5173/`, enter a unique buyer email, and buy one seeded listing.
2. Confirm Whop hosted checkout opens and complete it with the documented sandbox test
   payment method.
3. Confirm the buyer returns to `/orders/<order-uuid>` and the database order has a `ch_...`
   checkout configuration ID, the listing price snapshot, and `pending_payment` before its
   success webhook is processed.

## C4 — verified webhook reliability

1. In the Whop sandbox dashboard, register
   `<APP_BASE_URL>/api/webhooks/whop` for `payment.succeeded`, `payment.failed`,
   `payment.pending`, `refund.created`, `verification.succeeded`,
   `payout_method.created`, `payout_account.status_updated`, and
   `identity_profile.updated`. Store the returned secret once in `WHOP_WEBHOOK_SECRET`.
2. Complete C3 checkout and confirm the matching order moves from `pending_payment` to
   `paid`, with one applied `order_events` row linked to its inbox row.
3. Replay that same delivery from Whop’s webhook delivery controls. Confirm the endpoint
   returns 200, the inbox row is `duplicate`, and no second order transition exists.
4. Send a captured delivery body with one byte changed but its original Standard Webhooks
   headers. Confirm HTTP 401 and no new `webhook_events` row. Do not expose the secret while
   constructing this request.
5. Deliver `payment.pending` for the already-paid order (using Whop’s sandbox event tooling
   if available). Confirm the order stays `paid` and a linked `order_events` row records
   `applied=false`.

The credential-free equivalent of all four cases passes in `bun test server/app.test.ts`;
those tests sign crafted payloads with a test-only secret and use the real Whop SDK verifier.

## C5 — lifecycle and transfer

1. Verify the platform sandbox company is KYC-approved and has enough sandbox balance.
2. From `/orders/<order-uuid>`, accept, submit a deliverable, and approve it.
3. Confirm exactly one `payouts` row exists for the order, its persisted idempotency key was
   used, the Whop sandbox shows one `ctt_...` transfer to the seller `biz_...`, and the order
   reaches `paid_out`.
4. Call `POST /api/orders/<order-uuid>/approve` again. Confirm no second payout row or Whop
   transfer appears.
5. Repeat once with insufficient sandbox balance. Confirm the API returns 502 and the local
   payout/order show `failed`/`payout_failed` plus a failure reason.

Current official API/SDK surfaces expose transfer create/retrieve but no `transfer.*`
webhook or asynchronous status field. CreatorJobs therefore retrieves the created transfer
as its reconciliation fallback; re-check the pinned API version before the live pass and
document any newly available Experimental event rather than silently switching to Stable.

The automated payout suite also issues two approvals concurrently and verifies that the
persisted `pending → processing` claim permits exactly one outbound transfer call.

## C6 — database-only operations dashboard

1. After the C4 and C5 scenarios, open `http://localhost:5173/dashboard`.
2. Confirm Orders, Sellers, Payouts, Webhook feed, and Errors panels match database rows,
   including the duplicate inbox and rejected out-of-order transition.
3. Temporarily revoke network access to Whop or use browser developer tools to confirm a
   dashboard refresh still succeeds; only account-link regeneration should call Whop.
4. Select **Link** for a connected seller and confirm a fresh hosted onboarding URL opens
   and the seller row remains the same.

## C7 — Vercel deployment

Deployment is unverified because Vercel credentials were unavailable. The local build and
routing contracts pass: nested `/api/*` paths have a filesystem catch-all function and the
Vite SPA fallback no longer rewrites API paths to `/index.html`. When credentials are
available, deploy a preview, verify `/api/health` and a nested non-GET API route, then run the
live C2–C5 checks against that preview before promoting it.
