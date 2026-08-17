# Written scenarios — Technical CSM responses

Each answer follows the required structure: issue type, customer reply, internal action, urgency, evidence collected, and whether to escalate to engineering. Where relevant, the debugging paths cite real incidents hit and resolved while building this prototype — none of these are hypothetical.

---

## Scenario 1 — Buyer paid, order still pending

> "A buyer paid for a listing, but our marketplace still says the order is pending. Is Whop broken?"

**Issue type.** Webhook delivery/processing gap, not a payments failure. The charge almost certainly succeeded on Whop's side; what's missing is the `payment.succeeded` event reaching the marketplace, verifying, and applying the `pending_payment → paid` transition.

**Customer reply.**
"The buyer's money is safe — the payment either completed on Whop or it didn't, and I can confirm which in a couple of minutes. Your order status is driven by a webhook from Whop to your endpoint, so a 'stuck pending' order almost always means that one event didn't arrive or didn't apply, not that the payment failed. I'm tracing the delivery chain now and will reconcile the order either way. You'll have the order in the correct state shortly, plus the root cause so it can't recur silently."

**Internal action.** Follow the evidence trail the system keeps, in order:
1. Confirm the payment exists upstream: `GET /payments` filtered to the buyer/time window, note the `pay_…` id.
2. Check the `webhook_events` inbox for that event. Three branches:
   - **Not in the inbox** → the event never arrived. List webhooks (`GET /webhooks?account_id=…`) and verify one is registered, enabled, and pointed at the current deployment URL, subscribed to `payment.succeeded`. (We hit exactly this while building: zero webhooks registered — everything downstream looked "broken" while the app was working correctly.)
   - **In the inbox with `status = error`** → processing bug (e.g. checkout created without `metadata.order_id`, so the event can't map to an order). The raw payload is stored; fix the mapping, reprocess.
   - **Rejected 401 before persistence** → signing-secret mismatch, typically after a webhook was recreated or an env rollout raced the registration (we hit this window too).
3. Reconcile: once the payment is confirmed real, replay the missed event through the normal signed-webhook path. Idempotency guarantees make this safe — `whop_payment_id` is UNIQUE on orders, the inbox dedups on `webhook-id`, and the transition is a conditional UPDATE, so a duplicate replay is a logged no-op.
4. Check blast radius: one stuck order is a delivery hiccup; every recent order stuck means the endpoint, secret, or registration is broken → treat as systemic.

**Urgency.** High — money has been taken and the buyer sees nothing, which is a trust problem — but bounded: it is recoverable with no data loss, and the fix (reconciliation) takes minutes once diagnosed. Systemic variant (all orders stuck) escalates to critical.

**Evidence collected.** Whop payment id and status from the API; the `webhook_events` row (or its absence) for the event id; `api_request_log` entries around the window; `order_events` audit rows including rejected transitions; webhook registration list and destination URL; deploy timeline vs. event timestamp.

**Escalate to engineering?** Not for a single missed event — this is a runbook item (trace → reconcile), and the replay is an operator action. Escalate internally if the inbox shows `error` statuses (processing bug needs a code fix). Escalate to Whop support with message ids and timestamps if webhooks are registered and enabled but events demonstrably never arrive.

---

## Scenario 2 — Seller cannot receive payouts

> "The seller completed onboarding, but they still can't withdraw. This is blocking launch."

**Issue type.** Payout-readiness state machine confusion. "Completed onboarding" and "can withdraw" are separated by three independent gates: (1) the verification *decision* (submitting KYC ≠ approved), (2) a saved payout method, (3) settled balance. Each has different owners and timelines.

**Customer reply.**
"Good news first: this does not block the seller from *earning*. Marketplace payouts land in the seller's Whop balance regardless of withdrawal setup — nothing owed to them is lost or delayed by this. Withdrawal is a separate step with two requirements: their identity verification must be *approved* (submitting documents starts a review; it isn't instant), and they need a saved payout method. I've checked their account and can tell you exactly which gate they're at and what happens next — most of the time it's simply the verification decision still processing, which resolves on its own and fires an event our system picks up automatically."

**Internal action.**
1. `GET /verifications?account_id=biz_…` — the authoritative status (`processing` / `approved` / `action_required`). Note: the provider's own UI can show "verified" while Whop's record still says `processing` — we observed this lag directly; the webhook (`verification.succeeded`) is the fast signal, the polled status trails it. If `action_required`, the record lists exactly what to fix (e.g. a rejected selfie with the reason).
2. `GET /payouts/methods?account_id=…&include_available=true` — saved methods and available payout rails. Important boundary found during the build: **the sandbox exposes zero payout rails**, so withdrawal setup is impossible in test mode by design — if the customer is testing in sandbox, this is expected behavior, not a bug, and the write-up says so.
3. Check the ledger: funds from fresh checkouts sit in *pending* balance until settlement; a seller can have earnings that are real but not yet withdrawable.
4. If verification is stuck `processing` abnormally long, restart it via `POST /verifications` with `restart: true` and complete documents — the expedite we validated end-to-end.

**Urgency.** High by customer framing (launch-blocking), but the first move is scoping it correctly: earning is not blocked, so launch is not actually gated on this; withdrawal readiness can complete in parallel. Communicating that reframe immediately usually defuses the fire.

**Evidence collected.** Verification record (id, status, `updated_at`, any `requested_information` errors); payout methods list + `available_destinations`; ledger/pending balance; webhook inbox for `verification.succeeded` / `payout_method.created`; whether the environment is sandbox or production.

**Escalate to engineering?** Not to our engineering — no code is at fault. Escalate to **Whop support** if a verification stays `processing` well after the identity provider shows approval, or if the payout-destinations catalog is empty in *production* (in sandbox that's expected). Provide the verification id and timestamps.

---

## Scenario 3 — 401 on connected account API key

> "We created a connected seller, but all api calls return 401 errors."

**Issue type.** Credential-model misunderstanding, almost certainly. Creating a connected account (child company) does **not** mint credentials for it — there is no per-child API key. All API calls use the **platform's** key, acting on the child by passing its `biz_…` id (`account_id` / `company_id` / `parent_company_id` parameters as each endpoint requires).

**Customer reply.**
"Nothing is broken with your seller account — this is a model difference from platforms like Stripe that's easy to hit. Connected accounts on Whop don't get their own API keys. Every call is made with *your platform key*, and you tell the API which connected account to act on by passing its `biz_…` id as a parameter. So: keep the Authorization header exactly as you use it for platform calls, and add the seller's company id to the request parameters. If you send me one failing request (with the key redacted), I'll confirm the exact fix in one pass."

**Internal action.**
1. Reproduce with their exact request shape. Confirm the 401 is real authentication (`{"error":{"type":"unauthorized"}}`) and not a 400 masquerading in their client.
2. Verify environment pairing: sandbox keys work only against `sandbox-api.whop.com`, production keys only against the production host. A crossed pair is the second most common cause. (Our own first API call of the build returned exactly this 401 — an env var not loaded — captured in the request log.)
3. Check header shape (`Authorization: Bearer <key>`, no whitespace issues) and that the key wasn't rotated/revoked in the dashboard.
4. Confirm the platform key works on a platform-scoped call, then the same key on a child-scoped call with `account_id` — isolating whether *any* auth works vs. only child-scoped calls failing.

**Urgency.** Medium. It's a development-time blocker with no end-user or money impact, and resolution is typically minutes once the model is explained.

**Evidence collected.** One full failing request (method, URL, headers with key redacted to prefix, params) and raw response body; the environment of the key vs. the host called; whether platform-scoped calls succeed; `x-request-id` from responses if Whop support gets involved.

**Escalate to engineering?** No — this is configuration and education, resolved by the CSM. Escalate to Whop support only if a verified-active platform key 401s on platform-scoped calls, with request ids attached.

---

## Scenario 4 — Dashboard request

> "We need one dashboard showing buyer payment, order state, seller payout status, webhook delivery, and errors. Without this, our ops team is blind."

**Issue type.** Product/visibility request — and in this build, already satisfied: the ops dashboard at `/dashboard` was designed for exactly this "is it Whop or is it us" question.

**Customer reply.**
"You have this today — one page, five panels, all served from your own database so it answers from evidence rather than trusting anyone's status page. Orders shows every order with its payment id and state; Sellers shows each seller's verification ladder with one-click actions (regenerate a KYC link, open their withdrawals portal); Payouts shows every transfer with its id and failure reason if any; the Webhook feed shows every event received — including duplicates and rejected replays, which is how you distinguish 'Whop didn't send it' from 'we didn't process it'; and Errors collects failed API calls plus rejected state transitions. I'd like 30 minutes with your ops team to walk it and collect what's missing — filters, retention, alerting — so we can prioritize the next iteration."

**Internal action.** No unblocking work — demo the existing surface. Capture the requirements delta as a roadmap: search/filtering, date ranges, alerting on error-rate, webhook redelivery visibility. Note the design principle worth stating to the customer: the dashboard reads only the marketplace's own evidence tables (`orders`, `seller_profiles`, `payouts`, `webhook_events`, `order_events`, `api_request_log`), so every answer is auditable, and the admin actions on it (payout retry via re-approval, KYC link regeneration) are the same idempotent operations the runbooks use.

**Urgency.** Low as an incident (nothing is down), high as launch-readiness — ops visibility is a legitimate go-live requirement, so it's scheduled work, not backlog filler.

**Evidence collected.** Not an evidence-gathering scenario; the deliverables are the dashboard link, a walkthrough, and the gap list from the ops team.

**Escalate to engineering?** No. File the gap list as feature requests; nothing here is a defect.
