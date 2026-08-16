# CreatorJobs project guidance

## Scope

CreatorJobs is the standalone private repository for the Whop Technical CSM take-home. It is not part of ForgeGUI/gitreposit.

## Architecture

- React + Vite + TypeScript frontend in `src/`
- Hono API on the Node.js adapter in `server/`
- Bun is the package manager and local runtime
- Tailwind CSS consumes the single token source in `src/styles/tokens.css`
- Shared UI primitives belong in `src/components/ui/`

## Guardrails

- Keep secrets in ignored local environment files; commit placeholders only in `.env.example`.
- Do not add schemas or migrations until the marketplace entities and state transitions are reviewed.
- Verify Whop API behavior against current official docs. Prefer Experimental endpoints for the take-home and document any Stable fallback.
- Webhook work must verify signatures against the raw body, be idempotent, preserve delivery evidence, and tolerate retries and out-of-order events.
- Work on feature branches only; never push implementation directly to `main`.
