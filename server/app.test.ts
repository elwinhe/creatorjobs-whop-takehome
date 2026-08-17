import { describe, expect, test } from 'bun:test'
import Whop from '@whop/sdk'
import { Webhook } from 'standardwebhooks'
import { createMarketplaceApp } from './app.js'
import { approveOrderAndPay } from './domain.js'
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
} from './repository.js'
import type { WhopGateway } from './whop.js'

const orderId = '40000000-0000-4000-8000-000000000001'
const sellerId = '20000000-0000-4000-8000-000000000001'
const payoutId = '50000000-0000-4000-8000-000000000001'
const rawVerificationError = '400 {"error":{"type":"bad_request","message":"Please verify your business before transferring funds. Complete verification at https://whop.com/payouts/biz_test_company/verify/"}}'

type DashboardData = Record<'orders' | 'sellers' | 'payouts' | 'webhooks' | 'errors', unknown[]>

class MemoryRepository implements MarketplaceRepository {
  accountLinkCalls = 0
  createdSeller: { displayName: string; email: string } | null = null
  createdOrder: { buyerEmail: string; listingId: string } | null = null
  dashboard: DashboardData = { orders: [], sellers: [], payouts: [], webhooks: [], errors: [] }
  events: { applied: boolean; from: OrderStatus; to: OrderStatus }[] = []
  orderStatus: OrderStatus = 'pending_payment'
  payoutFailedReason: string | null = null
  payoutRows = 0
  payoutStatus = 'pending'
  returnOrder = true
  returnSeller = true
  savedCheckoutId: string | null = null
  transferId: string | null = null
  webhooks = new Map<string, { id: string; status: string }>()
  sellerState: SellerView = {
    display_name: 'Seller',
    email: 'seller@example.com',
    has_payout_method: false,
    id: sellerId,
    last_account_link_url: null,
    onboarding_status: 'created',
    whop_company_id: 'biz_seller',
  }

  async ping() { return true }
  async createSeller(email: string, displayName: string) {
    this.createdSeller = { displayName, email }
    this.sellerState = { ...this.sellerState, display_name: displayName, email, whop_company_id: null }
    return this.sellerState
  }
  async setSellerCompany(_sellerId: string, companyId: string) { this.sellerState.whop_company_id = companyId }
  async setAccountLink(_sellerId: string, url: string) {
    this.accountLinkCalls += 1
    this.sellerState.last_account_link_url = url
    this.sellerState.onboarding_status = 'link_sent'
  }
  async getSeller() { return this.returnSeller ? this.sellerState : null }
  async listListings(): Promise<ListingView[]> { return [] }
  async createOrder(listingId: string, buyerEmail: string): Promise<OrderDraft | null> {
    this.createdOrder = { buyerEmail, listingId }
    return this.returnOrder ? { amount_cents: 25000, currency: 'usd', id: orderId } : null
  }
  async setCheckout(_orderId: string, checkoutId: string) { this.savedCheckoutId = checkoutId }
  async getOrder() { return { id: orderId, status: this.orderStatus } }
  async getDashboard() { return this.dashboard }

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
    if (applied) {
      this.orderStatus = 'completed'
      this.payoutRows = 1
    }
    this.events.push({ applied, from, to: 'completed' })
    if (!applied && !['completed', 'payout_pending', 'paid_out', 'payout_failed'].includes(from)) return null
    const claimed = (this.payoutStatus === 'pending' && this.transferId === null) || this.payoutStatus === 'failed'
    if (claimed) {
      this.payoutStatus = 'processing'
      this.transferId = null
    }
    return {
      amount_cents: 25000,
      currency: 'usd',
      id: payoutId,
      idempotency_key: '60000000-0000-4000-8000-000000000001',
      order_id: targetOrderId,
      shouldTransfer: claimed,
      whop_company_id: 'biz_seller',
      whop_transfer_id: this.transferId,
    }
  }

  async markPayoutProcessing(_payoutId: string, targetOrderId: string, transferId: string) {
    this.payoutStatus = 'processing'
    this.transferId = transferId
    await this.transitionOrder({ actor: 'system', expected: ['completed', 'payout_failed'], orderId: targetOrderId, to: 'payout_pending' })
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

  async updateSellerReadiness(_companyId: string, eventType: string) {
    if (eventType === 'verification.succeeded') this.sellerState.onboarding_status = 'verified'
    if (eventType === 'payout_method.created') {
      this.sellerState.has_payout_method = true
      this.sellerState.onboarding_status = 'payout_ready'
    }
    return true
  }
}

function gateway(options: { failAccountLinkUseCase?: 'account_onboarding' | 'payouts_portal'; failTransfer?: boolean | string } = {}) {
  const rawSecret = 'creatorjobs-test-secret'
  const encodedSecret = Buffer.from(rawSecret).toString('base64')
  const verifier = new Whop({ apiKey: 'test', webhookKey: encodedSecret })
  const accountLinkInputs: Parameters<WhopGateway['createAccountLink']>[0][] = []
  const checkoutInputs: Parameters<WhopGateway['createCheckout']>[0][] = []
  const companyInputs: Parameters<WhopGateway['createCompany']>[0][] = []
  const retrievedTransfers: string[] = []
  const transferInputs: Parameters<WhopGateway['createTransfer']>[0][] = []
  let transferCalls = 0
  const whop: WhopGateway = {
    async createAccountLink(input) {
      accountLinkInputs.push(input)
      if (options.failAccountLinkUseCase === input.useCase) throw new Error('Whop payout portal unavailable')
      return { expires_at: new Date().toISOString(), url: `https://whop.test/link/${accountLinkInputs.length}` }
    },
    async createCheckout(input) {
      checkoutInputs.push(input)
      return { id: 'ch_test', purchase_url: 'https://whop.test/checkout' }
    },
    async createCompany(input) {
      companyInputs.push(input)
      return { id: 'biz_test_seller' }
    },
    async createTransfer(input) {
      transferCalls += 1
      transferInputs.push(input)
      if (options.failTransfer) throw new Error(typeof options.failTransfer === 'string' ? options.failTransfer : 'insufficient sandbox balance')
      return { id: 'tr_test' }
    },
    async retrieveTransfer(transferId: string) {
      retrievedTransfers.push(transferId)
      return { id: transferId }
    },
    verifyWebhook(rawBody, headers) { return verifier.webhooks.unwrap(rawBody, { headers }) },
  }
  return { accountLinkInputs, checkoutInputs, companyInputs, rawSecret, retrievedTransfers, transferCalls: () => transferCalls, transferInputs, whop }
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

describe('seller onboarding', () => {
  test('shapes connected-company and repeatable account-link requests', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    const create = await app.request('/api/sellers', {
      body: JSON.stringify({ display_name: 'Northstar Studio', email: 'CREATOR@EXAMPLE.COM' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(create.status).toBe(201)
    expect(repository.createdSeller).toEqual({ displayName: 'Northstar Studio', email: 'creator@example.com' })
    expect(fake.companyInputs).toEqual([{
      email: 'creator@example.com',
      parentCompanyId: 'biz_platform',
      sellerId,
      title: 'Northstar Studio',
    }])

    const first = await app.request(`/api/sellers/${sellerId}/account-link`, { method: 'POST' })
    const second = await app.request(`/api/sellers/${sellerId}/account-link`, { method: 'POST' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(fake.accountLinkInputs).toEqual([
      { companyId: 'biz_test_seller', refreshUrl: `http://localhost:5173/seller?id=${sellerId}`, returnUrl: `http://localhost:5173/seller?id=${sellerId}`, useCase: 'account_onboarding' },
      { companyId: 'biz_test_seller', refreshUrl: `http://localhost:5173/seller?id=${sellerId}`, returnUrl: `http://localhost:5173/seller?id=${sellerId}`, useCase: 'account_onboarding' },
    ])
    expect(repository.accountLinkCalls).toBe(2)
    expect(repository.sellerState.onboarding_status).toBe('link_sent')
  })

  test('returns a generic 502 without persisting when Whop cannot create an onboarding link', async () => {
    const repository = new MemoryRepository()
    const originalState = structuredClone(repository.sellerState)
    const fake = gateway({ failAccountLinkUseCase: 'account_onboarding' })
    const { app } = testApp(repository, fake.whop)

    const response = await app.request(`/api/sellers/${sellerId}/account-link`, { method: 'POST' })
    const body = await response.json() as { error: string }

    expect(response.status).toBe(502)
    expect(body).toEqual({ error: 'Whop account link creation failed' })
    expect(body.error).not.toContain('Whop payout portal unavailable')
    expect(repository.accountLinkCalls).toBe(0)
    expect(repository.sellerState).toEqual(originalState)
  })

  test('advances verified and payout-ready status from signed webhooks', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app, flush } = testApp(repository, fake.whop)

    for (const [eventId, type] of [['msg_verify', 'verification.succeeded'], ['msg_payout', 'payout_method.created']] as const) {
      const body = JSON.stringify({ company_id: 'biz_seller', data: {}, id: eventId, type })
      expect((await app.fetch(signedRequest(fake.rawSecret, eventId, body))).status).toBe(200)
    }
    await flush()

    const seller = await (await app.request(`/api/sellers/${sellerId}`)).json() as SellerView
    expect(seller.onboarding_status).toBe('payout_ready')
    expect(seller.has_payout_method).toBe(true)
  })

  test('creates fresh payout portal links without mutating seller state', async () => {
    const repository = new MemoryRepository()
    repository.sellerState = {
      ...repository.sellerState,
      has_payout_method: true,
      last_account_link_url: 'https://whop.test/onboarding/saved',
      onboarding_status: 'payout_ready',
    }
    const originalState = structuredClone(repository.sellerState)
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    const first = await app.request(`/api/sellers/${sellerId}/payout-portal-link`, { method: 'POST' })
    const second = await app.request(`/api/sellers/${sellerId}/payout-portal-link`, { method: 'POST' })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await first.json() as { url: string }).url).toBe('https://whop.test/link/1')
    expect((await second.json() as { url: string }).url).toBe('https://whop.test/link/2')
    expect(fake.accountLinkInputs).toEqual([
      { companyId: 'biz_seller', refreshUrl: `http://localhost:5173/seller?id=${sellerId}`, returnUrl: `http://localhost:5173/seller?id=${sellerId}`, useCase: 'payouts_portal' },
      { companyId: 'biz_seller', refreshUrl: `http://localhost:5173/seller?id=${sellerId}`, returnUrl: `http://localhost:5173/seller?id=${sellerId}`, useCase: 'payouts_portal' },
    ])
    expect(repository.accountLinkCalls).toBe(0)
    expect(repository.sellerState).toEqual(originalState)
  })

  test('rejects invalid and missing sellers before creating a payout portal link', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    const invalid = await app.request('/api/sellers/not-a-uuid/payout-portal-link', { method: 'POST' })
    repository.returnSeller = false
    const missing = await app.request(`/api/sellers/${sellerId}/payout-portal-link`, { method: 'POST' })

    expect(invalid.status).toBe(400)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'Seller not found' })
    expect(fake.accountLinkInputs).toHaveLength(0)
  })

  test('requires a connected company for a payout portal link', async () => {
    const repository = new MemoryRepository()
    repository.sellerState.whop_company_id = null
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    const response = await app.request(`/api/sellers/${sellerId}/payout-portal-link`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Seller connected account is not ready' })
    expect(fake.accountLinkInputs).toHaveLength(0)
  })

  test('returns a generic 502 without mutating seller state when Whop cannot create a payout portal link', async () => {
    const repository = new MemoryRepository()
    repository.sellerState = {
      ...repository.sellerState,
      has_payout_method: true,
      last_account_link_url: 'https://whop.test/onboarding/saved',
      onboarding_status: 'payout_ready',
    }
    const originalState = structuredClone(repository.sellerState)
    const fake = gateway({ failAccountLinkUseCase: 'payouts_portal' })
    const { app } = testApp(repository, fake.whop)

    const response = await app.request(`/api/sellers/${sellerId}/payout-portal-link`, { method: 'POST' })
    const body = await response.json() as { error: string }

    expect(response.status).toBe(502)
    expect(body).toEqual({ error: 'Whop payout portal link creation failed' })
    expect(body.error).not.toContain('Whop payout portal unavailable')
    expect(repository.accountLinkCalls).toBe(0)
    expect(repository.sellerState).toEqual(originalState)
  })
})

describe('listing checkout', () => {
  test('creates checkout from the local order snapshot and persists its ID', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)
    const listingId = '30000000-0000-4000-8000-000000000001'

    const response = await app.request('/api/orders', {
      body: JSON.stringify({ buyer_email: 'BUYER@EXAMPLE.COM', listing_id: listingId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ order_id: orderId, purchase_url: 'https://whop.test/checkout' })
    expect(repository.createdOrder).toEqual({ buyerEmail: 'buyer@example.com', listingId })
    expect(fake.checkoutInputs).toEqual([{
      amountCents: 25000,
      currency: 'usd',
      idempotencyKey: `checkout-${orderId}`,
      orderId,
      redirectUrl: `http://localhost:5173/orders/${orderId}`,
    }])
    expect(repository.savedCheckoutId).toBe('ch_test')
  })

  test('returns 404 without a Whop call when the listing is unavailable', async () => {
    const repository = new MemoryRepository()
    repository.returnOrder = false
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    const response = await app.request('/api/orders', {
      body: JSON.stringify({ buyer_email: 'buyer@example.com', listing_id: '30000000-0000-4000-8000-000000000001' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(404)
    expect(fake.checkoutInputs).toHaveLength(0)
  })
})

describe('Whop webhook reliability', () => {
  test('moves checkout order from pending_payment to paid', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app, flush } = testApp(repository, fake.whop)
    const body = JSON.stringify({
      api_version: 'v1', company_id: 'biz_platform', data: { id: 'pay_test', metadata: { order_id: orderId }, user: { id: 'user_test' } }, id: 'msg_paid', timestamp: new Date().toISOString(), type: 'payment.succeeded',
    })

    const response = await app.fetch(signedRequest(fake.rawSecret, 'msg_paid', body))
    expect(response.status).toBe(200)
    await flush()
    expect(repository.orderStatus).toBe('paid')
    expect(repository.events).toHaveLength(1)
    expect(repository.events[0]?.applied).toBe(true)
    expect(repository.webhooks.get('msg_paid')?.status).toBe('processed')
  })

  test('marks replay duplicate without a second transition', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app, flush } = testApp(repository, fake.whop)
    const body = JSON.stringify({
      data: { id: 'pay_replay', metadata: { order_id: orderId } }, id: 'msg_replay', type: 'payment.succeeded',
    })

    expect((await app.fetch(signedRequest(fake.rawSecret, 'msg_replay', body))).status).toBe(200)
    await flush()
    expect(repository.events).toHaveLength(1)

    const replay = await app.fetch(signedRequest(fake.rawSecret, 'msg_replay', body))
    expect(await replay.json()).toEqual({ accepted: true, duplicate: true })
    expect(repository.events).toHaveLength(1)
    expect(repository.webhooks.get('msg_replay')?.status).toBe('duplicate')
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
    expect(repository.payoutRows).toBe(1)
    expect(fake.transferCalls()).toBe(1)
    expect(fake.transferInputs).toEqual([{
      amountCents: 25000,
      currency: 'usd',
      destinationId: 'biz_seller',
      idempotencyKey: '60000000-0000-4000-8000-000000000001',
      orderId,
      originId: 'biz_platform',
      payoutId,
    }])
    expect(fake.retrievedTransfers).toEqual(['tr_test'])

    const duplicateApprove = await app.request(`/api/orders/${orderId}/approve`, { method: 'POST' })
    expect(duplicateApprove.status).toBe(200)
    expect(repository.payoutRows).toBe(1)
    expect(fake.transferCalls()).toBe(1)
  })

  test('captures a transfer failure without a second intent', async () => {
    const repository = new MemoryRepository()
    repository.orderStatus = 'delivered'
    const fake = gateway({ failTransfer: rawVerificationError })
    const { app } = testApp(repository, fake.whop)
    const response = await app.request(`/api/orders/${orderId}/approve`, { method: 'POST' })
    const body = await response.json() as { error: string }

    expect(response.status).toBe(502)
    expect(body).toEqual({ error: 'Payout processing failed' })
    expect(body.error).not.toContain('verify your business')
    expect(body.error).not.toContain('http')
    expect(body.error).not.toContain('biz_')
    expect(body.error).not.toContain('{')
    expect(repository.orderStatus as OrderStatus).toBe('payout_failed')
    expect(repository.payoutFailedReason).toBe(rawVerificationError)
    expect(fake.transferCalls()).toBe(1)
  })

  test('retries a failed payout with the same idempotency key and no second payout row', async () => {
    const repository = new MemoryRepository()
    repository.orderStatus = 'delivered'
    const options: { failTransfer?: boolean | string } = { failTransfer: 'insufficient sandbox balance' }
    const fake = gateway(options)
    const { app } = testApp(repository, fake.whop)

    expect((await app.request(`/api/orders/${orderId}/approve`, { method: 'POST' })).status).toBe(502)
    expect(repository.orderStatus as OrderStatus).toBe('payout_failed')
    expect(repository.payoutStatus).toBe('failed')

    options.failTransfer = false
    const retry = await app.request(`/api/orders/${orderId}/approve`, { method: 'POST' })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ payoutId, transferred: true })
    expect(repository.orderStatus as OrderStatus).toBe('paid_out')
    expect(repository.payoutStatus).toBe('succeeded')
    expect(repository.payoutRows).toBe(1)
    expect(fake.transferCalls()).toBe(2)
    expect(fake.transferInputs[0].idempotencyKey).toBe(fake.transferInputs[1].idempotencyKey)

    const third = await app.request(`/api/orders/${orderId}/approve`, { method: 'POST' })
    expect(third.status).toBe(200)
    expect(fake.transferCalls()).toBe(2)
  })

  test('claims the persisted payout before simultaneous approval calls transfer', async () => {
    const repository = new MemoryRepository()
    repository.orderStatus = 'delivered'
    const fake = gateway()

    const [first, second] = await Promise.all([
      approveOrderAndPay(repository, fake.whop, 'biz_platform', orderId),
      approveOrderAndPay(repository, fake.whop, 'biz_platform', orderId),
    ])

    expect(fake.transferCalls()).toBe(1)
    expect(repository.payoutRows).toBe(1)
    expect([first?.transferred, second?.transferred].sort()).toEqual([false, true])
  })
})

describe('operations dashboard', () => {
  test('reads local repository evidence without a Whop request', async () => {
    const repository = new MemoryRepository()
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    const response = await app.request('/api/dashboard')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ errors: [], orders: [], payouts: [], sellers: [], webhooks: [] })
    expect(fake.accountLinkInputs).toHaveLength(0)
    expect(fake.checkoutInputs).toHaveLength(0)
    expect(fake.companyInputs).toHaveLength(0)
    expect(fake.transferInputs).toHaveLength(0)
    expect(fake.retrievedTransfers).toHaveLength(0)
  })

  test('returns source-aware safe error messages without changing dashboard row shape', async () => {
    const repository = new MemoryRepository()
    repository.dashboard = {
      orders: [{ id: orderId, status: 'payout_failed' }],
      sellers: [{ id: sellerId, onboarding_status: 'payout_ready' }],
      payouts: [
        { failure_reason: rawVerificationError, id: 'verification-payout', status: 'failed' },
        { failure_reason: '503 upstream transfer service unavailable', id: 'generic-payout', status: 'failed' },
      ],
      webhooks: [{ error: '500 {"error":"failed at https://whop.com/payouts/biz_secret"}', id: 'failed-webhook', status: 'error' }],
      errors: [
        { error: rawVerificationError, id: 'verification-api', source: 'api', status_code: 400, summary: 'POST /transfers' },
        { error: 'upstream request timed out', id: 'generic-api', source: 'api', status_code: 503, summary: 'GET /transfers/tr_test' },
        { error: 'Rejected: order is not delivered', id: 'safe-transition', source: 'transition', status_code: null, summary: 'paid → completed' },
      ],
    }
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    const response = await app.request('/api/dashboard')
    const body = await response.json() as DashboardData
    const payouts = body.payouts as Array<Record<string, unknown>>
    const webhooks = body.webhooks as Array<Record<string, unknown>>
    const errors = body.errors as Array<Record<string, unknown>>

    expect(response.status).toBe(200)
    expect(payouts[0]).toEqual({
      failure_reason: 'Platform business verification is required before transfers can be processed.',
      id: 'verification-payout',
      status: 'failed',
    })
    expect(payouts[1]?.failure_reason).toBe('Payout processing failed. Review internal logs for details.')
    expect(webhooks[0]?.error).toBe('Webhook processing failed. Review internal logs for details.')
    expect(errors[0]?.error).toBe('Platform business verification is required before transfers can be processed.')
    expect(errors[1]?.error).toBe('Provider request failed. Review internal logs for details.')
    expect(errors[2]?.error).toBe('Rejected: order is not delivered')
    expect(body.orders).toEqual(repository.dashboard.orders)
    expect(body.sellers).toEqual(repository.dashboard.sellers)

    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('verify your business')
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('biz_')
    expect(serialized).not.toContain('upstream request timed out')
  })

  test('sanitizes known and generic payout-failure transition errors as payout failures', async () => {
    const repository = new MemoryRepository()
    repository.dashboard.errors = [
      { error: rawVerificationError, id: 'verification-payout-transition', source: 'transition', status_code: null, summary: 'completed → payout_failed' },
      { error: 'upstream request timed out', id: 'generic-payout-transition', source: 'transition', status_code: null, summary: 'payout_pending → payout_failed' },
    ]
    const fake = gateway()
    const { app } = testApp(repository, fake.whop)

    const response = await app.request('/api/dashboard')
    const body = await response.json() as DashboardData
    const errors = body.errors as Array<Record<string, unknown>>

    expect(response.status).toBe(200)
    expect(errors[0]?.error).toBe('Platform business verification is required before transfers can be processed.')
    expect(errors[1]?.error).toBe('Payout processing failed. Review internal logs for details.')
    expect(JSON.stringify(errors)).not.toContain('verify your business')
    expect(JSON.stringify(errors)).not.toContain('upstream request timed out')
    expect((repository.dashboard.errors[0] as Record<string, unknown>).error).toBe(rawVerificationError)
    expect((repository.dashboard.errors[1] as Record<string, unknown>).error).toBe('upstream request timed out')
  })
})
