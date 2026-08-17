import type { MarketplaceRepository, OrderStatus } from './repository.js'
import type { WhopGateway } from './whop.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function paymentOrderId(data: JsonObject): string | undefined {
  return string(object(data.metadata)?.order_id)
}

function refundOrderId(data: JsonObject): string | undefined {
  const payment = object(data.payment)
  return payment ? paymentOrderId(payment) : undefined
}

export async function processWebhookEvent(
  repository: MarketplaceRepository,
  inboxId: string,
  event: unknown,
): Promise<void> {
  const envelope = object(event)
  const eventType = string(envelope?.type)
  const data = object(envelope?.data)

  try {
    if (!eventType || !data) throw new Error('Webhook envelope is missing type or data')

    if (eventType === 'payment.succeeded') {
      const orderId = paymentOrderId(data)
      const paymentId = string(data.id)
      if (!orderId || !paymentId) throw new Error('Payment webhook is missing metadata.order_id or id')
      const userId = string(object(data.user)?.id)
      const result = await repository.recordPaymentSucceeded({
        orderId,
        paymentId,
        webhookEventId: inboxId,
        whopUserId: userId,
      })
      if (!result) throw new Error(`Order not found: ${orderId}`)
      await repository.markWebhook(inboxId, 'processed')
      return
    }

    const orderTransition: Record<
      string,
      { expected: OrderStatus[]; orderId: string | undefined; to: OrderStatus }
    > = {
      'payment.failed': { expected: ['pending_payment'], orderId: paymentOrderId(data), to: 'canceled' },
      'payment.pending': { expected: [], orderId: paymentOrderId(data), to: 'pending_payment' },
      'refund.created': { expected: ['paid'], orderId: refundOrderId(data), to: 'refunded' },
    }
    const transition = orderTransition[eventType]
    if (transition) {
      if (!transition.orderId) throw new Error(`${eventType} is missing metadata.order_id`)
      const result = await repository.transitionOrder({
        actor: 'webhook',
        expected: transition.expected,
        note: `Whop ${eventType}`,
        orderId: transition.orderId,
        to: transition.to,
        webhookEventId: inboxId,
      })
      if (!result) throw new Error(`Order not found: ${transition.orderId}`)
      await repository.markWebhook(inboxId, 'processed')
      return
    }

    if (
      eventType === 'verification.succeeded' ||
      eventType === 'payout_method.created' ||
      eventType === 'payout_account.status_updated'
    ) {
      const companyId = string(envelope?.company_id) ?? string(data.company_id)
      if (!companyId) throw new Error(`${eventType} is missing company_id`)
      const updated = await repository.updateSellerReadiness(companyId, eventType)
      await repository.markWebhook(inboxId, updated ? 'processed' : 'ignored')
      return
    }

    await repository.markWebhook(inboxId, 'ignored')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await repository.markWebhook(inboxId, 'error', message)
    throw error
  }
}

export async function approveOrderAndPay(
  repository: MarketplaceRepository,
  whop: WhopGateway,
  platformCompanyId: string,
  orderId: string,
): Promise<{ payoutId: string; transferred: boolean } | null> {
  const payout = await repository.approveAndCreatePayout(orderId)
  if (!payout) return null
  if (!payout.shouldTransfer) return { payoutId: payout.id, transferred: false }

  try {
    const transfer = await whop.createTransfer({
      amountCents: payout.amount_cents,
      currency: payout.currency,
      destinationId: payout.whop_company_id,
      idempotencyKey: payout.idempotency_key,
      orderId: payout.order_id,
      originId: platformCompanyId,
      payoutId: payout.id,
    })
    await repository.markPayoutProcessing(payout.id, orderId, transfer.id)
    await whop.retrieveTransfer(transfer.id)
    await repository.markPayoutSucceeded(payout.id, orderId)
    return { payoutId: payout.id, transferred: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await repository.markPayoutFailed(payout.id, orderId, reason)
    // Buyer approval already succeeded and is committed; a transfer failure is a
    // retryable settlement concern surfaced to ops, not an error thrown at the buyer.
    return { payoutId: payout.id, transferred: false }
  }
}
