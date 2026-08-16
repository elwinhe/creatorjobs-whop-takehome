import { describe, expect, test } from 'bun:test'
import Whop from '@whop/sdk'
import { Webhook } from 'standardwebhooks'
import { createMarketplaceApp } from './app.ts'
import type {
  Actor,
  ListingView,
  MarketplaceRepository,
  OrderDraft,
  OrderStatus,
  PayoutIntent,
  SellerView,
  TransitionResult,
  WebhookInboxInput,
  WebhookInboxResult,
} from './repository.ts'
import type { WhopGateway } from './whop.ts'

const orderId = '40000000-0000-4000-8000-000000000001'
const sellerId = '20000000-0000-4000-8000-000000000001'
const payoutId = '50000000-0000-4000-8000-000000000001'

class MemoryRepository implements MarketplaceRepository {
  events: { applied: boolean; from: OrderStatus; to: OrderStatus }[] = []
  orderStatus: OrderStatus = 'pending_payment'
  payoutFailedReason: string | null = null
  payoutStatus = 'pending'
  transferId: string | null = null
  webhooks = new Map<string, { id: string; status: string }>()

  async ping() { return true }
  async createSeller(email: string, displayName: string) { return this.seller(email, displayName) }
  async setSellerCompany() {}
  async setAccountLink() {}
  async getSeller() { return this.seller('seller@example.com', 'Seller') }
  async listListings(): Promise<ListingView[]> { return [] }
  async createOrder(): Promise<OrderDraft | null> { return { amount_cents: 25000, currency: 'usd', id: orderId } }
  async setCheckout() {}
  async getOrder() { return { id: orderId, status: this.orderStatus } }
  async getDashboard() { return { orders: [], sellers: [], payouts: [], webhooks: [], errors: [] } }

  async transitionOrder(input: {
    actor: Actor
    expected: OrderStatus[]
    note?: string
    orderId: string
    to: OrderStatus
    webhookEventId?: string
  }): Promise<TransitionResult | null> {
    const from = this.orderStatus
    const applied = input.expected.includes(from) && from !== input.to
    if (applied) this.orderStatus = input.to
    this.events.push({ applied, from, to: input.to })
    return { applied, currentStatus: this.orderStatus, orderId: input.orderId }
  }

  async recordPaymentSucceeded(input: {
    orderId: string
    paymentId: string
    webhookEventId: string
    whopUserId?: string
  }) {
    return this.transitionOrder({ actor: 'webhook', expected: ['pending_payment'], orderId: input.orderId, to: 'paid' })
  }

  async createSubmission(targetOrderId: string): Promise<TransitionResult | null> {
    return this.transitionOrder({ actor: 'seller', expected: ['in_progress'], orderId: targetOrderId, to: 'delivered' })
  }

  async reviewSubmission(targetOrderId: string): Promise<TransitionResult | null> {
    return this.transitionOrder({ actor: 'buyer', expected: ['delivered'], orderId: targetOrderId, to: 'in_progress' })
  }

  async approveAndCreatePayout(targetOrderId: string): Promise<PayoutIntent | null> {
    const from = this.orderStatus
    const applied = from === 'delivered'
    if (applied) this.orderStatus = 'completed'
    this.events.push({ applied, from, to: 'completed' })
    if (!applied && !['completed', 'payout_pending', 'paid_out', 'payout_failed'].includes(from)) return null
    return {
      amount_cents: 25000,
      currency: 'usd',
      id: payoutId,
      idempotency_key: '60000000-0000-4000-8000-000000000001',
      order_id: targetOrderId,
      shouldTransfer: this.payoutStatus === 'pending' && this.transferId === null,
      whop_company_id: 'biz_seller',
      whop_transfer_id: this.transferId,
    }
  }

  async markPayoutProcessing(_payoutId: string, targetOrderId: string, transferId: string) {
    this.payoutStatus = 'processing'
    this.transferId = transferId
    await this.transitionOrder({ actor: 'system', expected: ['completed'], orderId: targetOrderId, to: 'payout_pending' })
  }

  async markPayoutSucceeded(_payoutId: string, targetOrderId: string) {
    this.payoutStatus = 'succeeded'
    await this.transitionOrder({ actor: 'system', expected: ['payout_pending'], orderId: targetOrderId, to: 'paid_out' })
  }

  async markPayoutFailed(_payoutId: string, targetOrderId: string, reason: string) {
    this.payoutStatus = 'failed'
    this.payoutFailedReason = reason
    await this.transitionOrder({ actor: 'system', expected: ['completed', 'payout_pending'], orderId: targetOrderId, to: 'payout_failed' })
  }

  async insertWebhook(input: WebhookInboxInput): Promise<WebhookInboxResult> {
    const existing = this.webhooks.get(input.eventId)
    if (existing) {
      existing.status = 'duplicate'
      return { duplicate: true, id: existing.id }
    }
    const value = { id: `inbox-${this.webhooks.size + 1}`, status: 'received' }
    this.webhooks.set(input.eventId, value)
    return { duplicate: false, id: value.id }
  }

  async markWebhook(id: string, status: 'processed' | 'ignored' | 'error') {
    const webhook = [...this.webhooks.values()].find((value) => value.id === id)
    if (webhook && webhook.status !== 'duplicate') webhook.status = status
  }

  async updateSellerReadiness() { return true }

  private seller(email: string, displayName: string): SellerView {
    return {
      display_name: displayName,
      email,
      has_payout_method: false,
      id: sellerId,
      last_account_link_url: null,
      onboarding_status: 'created',
      whop_company_id: 'biz_seller',
    }
  }
}

function gateway(options: { failTransfer?: boolean } = {}) {
  const rawSecret = 'creatorjobs-test-secret'
  const encodedSecret = Buffer.from(rawSecret).toString('base64')
  const verifier = new Whop({ apiKey: 'test', webhookKey: encodedSecret })
  let transferCalls = 0
  const whop: WhopGateway = {
    async createAccountLink() { return { expires_at: new Date().toISOString(), url: 'https://whop.test/link' } },
    async createCheckout() { return { id: 'ch_test', purchase_url: 'https://whop.test/checkout' } },
    async createCompany() { return { id: 'biz_test_seller' } },
    async createTransfer() {
      transferCalls += 1
      if (options.failTransfer) throw new Error('insufficient sandbox balance')
      return { id: 'tr_test' }
    },
    async retrieveTransfer(transferId: string) { return { id: transferId } },
    verifyWebhook(rawBody, headers) { return verifier.webhooks.unwrap(rawBody, { headers }) },
  }
  return { rawSecret, transferCalls: () => transferCalls, whop }
}

function signedRequest(rawSecret: string, eventId: string, body: string): Request {
  const timestamp = new Date()
  const signer = new Webhook(Buffer.from(rawSecret).toString('base64'))
  return new Request('http://localhost/api/webhooks/whop', {
    body,
    headers: {
      'content-type': 'application/json',
      'webhook-id': eventId,
      'webhook-signature': signer.sign(eventId, timestamp, body),
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    },
    method: 'POST',
  })
}

function testApp(repository: MemoryRepository, whop: WhopGateway) {
  const deferred: Promise<void>[] = []
  const app = createMarketplaceApp({
    appBaseUrl: 'http://localhost:5173',
    defer: (task) => deferred.push(task),
    environment: 'test',
    platformCompanyId: 'biz_platform',
    repository,
    whop,
  })
  return { app, flush: () => Promise.all(deferred) }
}

describe('Whop webhook reliability', () => {
  test('applies a signed payment once and marks a replay duplicate', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app, flush } = testApp(repository, fake.whop)
    const body = JSON.stringify({
      api_version: 'v1', company_id: 'biz_platform', data: { id: 'pay_test', metadata: { order_id: orderId }, user: { id: 'user_test' } }, id: 'msg_1', timestamp: new Date().toISOString(), type: 'payment.succeeded',
    })

    const first = await app.fetch(signedRequest(fake.rawSecret, 'msg_1', body))
    expect(first.status).toBe(200)
    await flush()
    expect(repository.orderStatus).toBe('paid')
    expect(repository.events).toHaveLength(1)
    expect(repository.events[0]?.applied).toBe(true)

    const replay = await app.fetch(signedRequest(fake.rawSecret, 'msg_1', body))
    expect(await replay.json()).toEqual({ accepted: true, duplicate: true })
    expect(repository.events).toHaveLength(1)
    expect(repository.webhooks.get('msg_1')?.status).toBe('duplicate')
  })

  test('rejects a tampered payload before persistence', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)
    const original = JSON.stringify({ data: {}, id: 'msg_2', type: 'payment.succeeded' })
    const request = signedRequest(fake.rawSecret, 'msg_2', original)
    const tampered = new Request(request, { body: original.replace('succeeded', 'failed') })
    const response = await app.fetch(tampered)
    expect(response.status).toBe(401)
    expect(repository.webhooks.size).toBe(0)
  })

  test('keeps an out-of-order transition as rejected evidence', async () => {
    const repository = new MemoryRepository()
    repository.orderStatus = 'paid'
    const fake = gateway()
    const { app, flush } = testApp(repository, fake.whop)
    const body = JSON.stringify({ data: { id: 'pay_test', metadata: { order_id: orderId } }, id: 'msg_3', type: 'payment.pending' })
    const response = await app.fetch(signedRequest(fake.rawSecret, 'msg_3', body))
    expect(response.status).toBe(200)
    await flush()
    expect(repository.orderStatus).toBe('paid')
    expect(repository.events.at(-1)).toEqual({ applied: false, from: 'paid', to: 'pending_payment' })
  })
})

describe('order lifecycle and payout idempotency', () => {
  test('accepts, submits, approves, and never transfers twice', async () => {
    const repository = new MemoryRepository()
    repository.orderStatus = 'paid'
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    expect((await app.request(`/api/orders/${orderId}/accept`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/orders/${orderId}/submit`, { body: JSON.stringify({ note: 'Delivered' }), headers: { 'content-type': 'application/json' }, method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/orders/${orderId}/approve`, { method: 'POST' })).status).toBe(200)
    expect(repository.orderStatus as OrderStatus).toBe('paid_out')
    expect(fake.transferCalls()).toBe(1)

    const duplicateApprove = await app.request(`/api/orders/${orderId}/approve`, { method: 'POST' })
    expect(duplicateApprove.status).toBe(200)
    expect(fake.transferCalls()).toBe(1)
  })

  test('captures a transfer failure without a second intent', async () => {
    const repository = new MemoryRepository()
    repository.orderStatus = 'delivered'
    const fake = gateway({ failTransfer: true })
    const { app } = testApp(repository, fake.whop)
    const response = await app.request(`/api/orders/${orderId}/approve`, { method: 'POST' })
    expect(response.status).toBe(502)
    expect(repository.orderStatus as OrderStatus).toBe('payout_failed')
    expect(repository.payoutFailedReason).toBe('insufficient sandbox balance')
    expect(fake.transferCalls()).toBe(1)
  })
})
