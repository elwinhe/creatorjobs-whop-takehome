# Validation report

Validation was completed on 2026-08-16/17 using an isolated hosted Postgres database and
Whop's sandbox. This report separates observed live behavior from automated coverage and
from requirements that remain incomplete or unverified.

## Status matrix

| Area | Status | Evidence |
| --- | --- | --- |
| Health | Live passed | `/api/health` returned `{ ok: true, db: true }` against isolated hosted Postgres. |
| Database | Live passed | Migration and deterministic seed completed twice without duplicate data. |
| Seller onboarding | Live passed, payout setup partial | A real connected child company was created and distinct hosted onboarding links were reachable. The app does not provide a payout-method setup UI. |
| Checkout | Live passed | A hosted sandbox checkout completed; Whop reported the payment `paid`, preserved the local order metadata, and redirected to the order page. |
| Webhooks | Live passed | Signed success, replay, tamper rejection, and out-of-order delivery behavior were observed through a temporary HTTPS endpoint. |
| Lifecycle and payout | Lifecycle live passed; transfer provider-blocked | The order reached `completed` and created one payout intent. Whop rejected the sandbox transfer; no live `paid_out` state is claimed. Transfer success and idempotency are covered by automated tests. |
| Operations dashboard | Automated passed; manual browser QA unverified | The five database-only panels and account-link regeneration have contract coverage. |
| Deployment | Build/routing passed; public deployment missing | Production build, routing contracts, and Vercel `waitUntil` adapter wiring pass automated checks, but no public Vercel deployment or manual deployed verification exists. |

## Live evidence

- Health: the health endpoint confirmed both the API and isolated hosted database were healthy.
- Database: migration and seed succeeded twice, demonstrating idempotent setup.
- Seller onboarding: the sandbox Company API key was accepted, a connected child company
  was created for a seller, and regenerated account links were distinct and reachable. The
  platform company's individual and business verification records later both showed
  `approved`, with no requested information.
- Checkout: checkout completed with Whop's documented sandbox test card. Whop reported the
  payment `paid`; its metadata mapped to the local order, and the browser returned to the
  CreatorJobs order page.
- Webhooks: a signed `payment.succeeded` delivery changed the order from `pending_payment` to
  `paid`. Replaying it returned 200 without a second applied transition. A tampered body
  returned 401 and persisted nothing. A later signed `payment.pending` was stored with
  `applied=false` while the order remained `paid`. The temporary webhook and tunnel were
  removed after validation.
- Lifecycle and payout: the local lifecycle reached
  `paid -> in_progress -> delivered -> completed`. Approval created exactly one payout row
  with one persisted idempotency key. The transfer
  endpoint was reached after both platform verification records were approved, but Whop
  rejected the sandbox payout.

No credentials, private contact details, one-time links, webhook payloads, or unnecessary
external identifiers are included in this report.

## Automated evidence

The final validation run passed 21 tests with 79 assertions, plus lint, typecheck, and the
production build. Coverage includes:

- webhook signature verification, duplicate delivery, tampered-body rejection, and
  out-of-order state handling;
- mocked transfer success, upstream failure capture, duplicate approval, and simultaneous
  approval ownership/idempotency;
- the five-panel database-only operations dashboard and account-link regeneration; and
- Vercel/API routing, `waitUntil` adapter wiring, and production-build contracts.

Automated coverage is not evidence of a successful live transfer, a completed manual
dashboard browser pass, or a public deployment.

## Provider limitation

Whop's [official sandbox documentation](https://docs.whop.com/developer/guides/sandbox)
states that payout functionality is not available yet. The live transfer attempt reached
Whop and was rejected in that environment, so a successful transfer and `paid_out` state
remain unverified. Mocked transfer tests establish application behavior only.

## Remaining gaps

### Functional and deployment readiness

- Seller payout setup is partial. CreatorJobs creates an `account_onboarding` KYC link and
  observes payout-method webhooks, but it exposes neither a `payouts_portal` link nor an
  embedded add-payout-method flow.
- The Vercel entrypoint passes [`waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)
  into the runtime as `defer`, and an adapter contract test protects that wiring. This
  extends post-response processing only within the Vercel function lifecycle: it does not
  provide queue persistence, automatic retries, or survival beyond the function timeout.
  A public deployment and manual deployed webhook verification remain missing.
- Manual browser QA of all five dashboard panels has not been recorded.
- A successful live payout must be verified in an environment where Whop enables payouts.

### Submission artifacts

- The four required written Technical CSM scenario answers are absent.
- No public deployment URL exists.
- No Loom or other short demonstration video exists.
