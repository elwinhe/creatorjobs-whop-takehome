# Deferred live gates

CreatorJobs is code-complete against mocked Whop boundaries, but this implementation run had
no `DATABASE_URL`, Whop sandbox credentials, or webhook secret. Run these checks later with
secrets in an ignored `.env.local`; never paste credentials into commands or commit them.

## C1 — hosted Postgres migration and seed

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

