# CreatorJobs

CreatorJobs is a minimal marketplace prototype for the Whop Technical CSM take-home. Businesses hire creators, creators complete work, and operators reconcile payments, orders, seller onboarding, payouts, webhooks, and errors.

This repository is private and independent from ForgeGUI/gitreposit.

## Foundation

- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS 4
- **API:** Hono on the Node.js server adapter
- **Runtime/package manager:** Bun
- **Payments/platform:** Whop SDK, configured for sandbox by default
- **Database:** Supabase Postgres connection reserved through `DATABASE_URL`; schema and migrations are intentionally deferred to the next design step

## Local setup

```bash
bun install
cp .env.example .env.local
bun run dev
```

The Vite app runs at `http://localhost:5173`. The Hono API runs at `http://localhost:3001`, and Vite proxies `/api/*` requests to it.

Do not commit credentials. Put the provided Supabase connection string and future Whop sandbox secrets only in `.env.local`.

## Commands

```bash
bun run dev        # frontend and API together
bun run lint       # Oxlint
bun run typecheck  # TypeScript project references
bun run build      # typecheck and production frontend build
bun run check      # all validation
```

## Design system

Visual constants live in `src/styles/tokens.css`. Components consume semantic Tailwind utilities rather than repeating colors, radii, shadows, or typography.

```text
tokens.css
  ↓
src/components/ui/*
  ↓
feature components and screens
```

The palette uses a cool neutral canvas, near-black ink, and orange as the single action/status accent. Manrope is the product typeface; IBM Plex Mono is reserved for operational metadata and IDs.

## Current boundary

Step 1 includes repository scaffolding, environment boundaries, the Node-compatible health endpoint, centralized design tokens, reusable UI primitives, and a responsive starter screen.

It does **not** yet include database tables, migrations, authentication, Whop API calls, checkout, connected-account onboarding, webhook handling, order transitions, or deployment. Those choices should follow an explicit schema and state-machine review.

## Documentation consulted

- [Whop API quickstart](https://docs.whop.com/developer/api/quickstart)
- [Whop marketplace example integration](https://docs.whop.com/developer/guides/example-integration)
- [Whop sandbox guide](https://docs.whop.com/developer/guides/sandbox)
- [Whop webhook guide](https://docs.whop.com/developer/guides/webhooks)
- [Whop connected-account enrollment](https://docs.whop.com/developer/platforms/enroll-connected-accounts)

The next pass should prefer Whop Experimental endpoints where the take-home requests them and record any Stable API fallback.
