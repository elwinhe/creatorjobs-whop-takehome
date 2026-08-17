type DashboardData = Record<'orders' | 'sellers' | 'payouts' | 'webhooks' | 'errors', unknown[]>
type DashboardRow = Record<string, unknown>

const BUSINESS_VERIFICATION_MESSAGE = 'Platform business verification is required before transfers can be processed.'
const PAYOUT_FAILURE_MESSAGE = 'Payout processing failed. Review internal logs for details.'
const PROVIDER_FAILURE_MESSAGE = 'Provider request failed. Review internal logs for details.'
const WEBHOOK_FAILURE_MESSAGE = 'Webhook processing failed. Review internal logs for details.'
const TRANSITION_FAILURE_MESSAGE = 'Transition rejected. Review internal logs for details.'

function isDashboardRow(value: unknown): value is DashboardRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBusinessVerificationFailure(value: unknown): boolean {
  const message = String(value ?? '')
  return /verify your business/i.test(message) && /transfers?|transferring funds/i.test(message)
}

function providerMessage(value: unknown, fallback: string): string {
  return isBusinessVerificationFailure(value) ? BUSINESS_VERIFICATION_MESSAGE : fallback
}

function safeTransitionMessage(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  const containsProviderData =
    /https?:\/\/|www\./i.test(trimmed) ||
    /\bbiz_[a-z0-9]+\b/i.test(trimmed) ||
    /^\s*[[{]/.test(trimmed) ||
    /["'](?:error|message)["']\s*:/i.test(trimmed)
  return containsProviderData ? TRANSITION_FAILURE_MESSAGE : value
}

function isPayoutFailureTransition(row: DashboardRow): boolean {
  return typeof row.summary === 'string' && /\u2192\s*payout_failed\s*$/.test(row.summary)
}

function sanitizePayout(row: unknown): unknown {
  if (!isDashboardRow(row) || row.failure_reason == null) return row
  return { ...row, failure_reason: providerMessage(row.failure_reason, PAYOUT_FAILURE_MESSAGE) }
}

function sanitizeWebhook(row: unknown): unknown {
  if (!isDashboardRow(row) || (row.error == null && row.status !== 'error')) return row
  return { ...row, error: providerMessage(row.error, WEBHOOK_FAILURE_MESSAGE) }
}

function sanitizeError(row: unknown): unknown {
  if (!isDashboardRow(row)) return row
  if (row.source === 'api') return { ...row, error: providerMessage(row.error, PROVIDER_FAILURE_MESSAGE) }
  if (row.source === 'transition') {
    const error = isPayoutFailureTransition(row)
      ? providerMessage(row.error, PAYOUT_FAILURE_MESSAGE)
      : safeTransitionMessage(row.error)
    return { ...row, error }
  }
  return { ...row, error: providerMessage(row.error, PROVIDER_FAILURE_MESSAGE) }
}

export function dashboardView(dashboard: DashboardData): DashboardData {
  return {
    ...dashboard,
    payouts: dashboard.payouts.map(sanitizePayout),
    webhooks: dashboard.webhooks.map(sanitizeWebhook),
    errors: dashboard.errors.map(sanitizeError),
  }
}
