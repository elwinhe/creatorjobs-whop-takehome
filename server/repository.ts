import type postgres from 'postgres'
import type { Database } from './db.ts'

export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'in_progress'
  | 'delivered'
  | 'completed'
  | 'payout_pending'
  | 'paid_out'
  | 'payout_failed'
  | 'canceled'
  | 'refunded'

export type Actor = 'webhook' | 'buyer' | 'seller' | 'admin' | 'system'

export type TransitionResult = {
  applied: boolean
  currentStatus: OrderStatus
  orderId: string
}

export type SellerView = {
  display_name: string
  email: string
  has_payout_method: boolean
  id: string
  last_account_link_url: string | null
  onboarding_status: string
  whop_company_id: string | null
}

export type ListingView = {
  currency: string
  description: string
  id: string
  price_cents: number
  seller_name: string
  title: string
}

export type OrderDraft = {
  amount_cents: number
  currency: string
  id: string
}

export type PayoutIntent = {
  amount_cents: number
  currency: string
  id: string
  idempotency_key: string
  order_id: string
  shouldTransfer: boolean
  whop_company_id: string
  whop_transfer_id: string | null
}

export type WebhookInboxInput = {
  apiVersionDate?: string
  companyId?: string
  eventId: string
  eventType: string
  payload: unknown
  rawBody: string
}

export type WebhookInboxResult = { duplicate: boolean; id: string }

export interface MarketplaceRepository {
  approveAndCreatePayout(orderId: string): Promise<PayoutIntent | null>
  createOrder(listingId: string, buyerEmail: string): Promise<OrderDraft | null>
  createSeller(email: string, displayName: string): Promise<SellerView>
  createSubmission(orderId: string, contentUrl: string | null, note: string | null): Promise<TransitionResult | null>
  getDashboard(): Promise<Record<'orders' | 'sellers' | 'payouts' | 'webhooks' | 'errors', unknown[]>>
  getOrder(orderId: string): Promise<Record<string, unknown> | null>
  getSeller(sellerId: string): Promise<SellerView | null>
  insertWebhook(input: WebhookInboxInput): Promise<WebhookInboxResult>
  listListings(): Promise<ListingView[]>
  markPayoutFailed(payoutId: string, orderId: string, reason: string): Promise<void>
  markPayoutProcessing(payoutId: string, orderId: string, transferId: string): Promise<void>
  markPayoutSucceeded(payoutId: string, orderId: string): Promise<void>
  markWebhook(id: string, status: 'processed' | 'ignored' | 'error', error?: string): Promise<void>
  ping(): Promise<boolean>
  recordPaymentSucceeded(input: {
    orderId: string
    paymentId: string
    webhookEventId: string
    whopUserId?: string
  }): Promise<TransitionResult | null>
  reviewSubmission(orderId: string, action: 'reject'): Promise<TransitionResult | null>
  setAccountLink(sellerId: string, url: string): Promise<void>
  setCheckout(orderId: string, checkoutId: string): Promise<void>
  setSellerCompany(sellerId: string, companyId: string): Promise<void>
  transitionOrder(input: {
    actor: Actor
    expected: OrderStatus[]
    note?: string
    orderId: string
    to: OrderStatus
    webhookEventId?: string
  }): Promise<TransitionResult | null>
  updateSellerReadiness(companyId: string, eventType: string): Promise<boolean>
}

type SqlTransaction = postgres.TransactionSql<Record<string, unknown>>

async function appendTransition(
  sql: SqlTransaction,
  input: {
    actor: Actor
    applied: boolean
    from: OrderStatus
    note?: string
    orderId: string
    to: OrderStatus
    webhookEventId?: string
  },
): Promise<void> {
  await sql`
    insert into order_events
      (order_id, from_status, to_status, applied, actor, webhook_event_id, note)
    values (
      ${input.orderId}, ${input.from}, ${input.to}, ${input.applied}, ${input.actor},
      ${input.webhookEventId ?? null}, ${input.note ?? null}
    )
  `
}

export class PostgresMarketplaceRepository implements MarketplaceRepository {
  private readonly sql: Database

  constructor(sql: Database) {
    this.sql = sql
  }

  async ping(): Promise<boolean> {
    const [row] = await this.sql<{ ok: number }[]>`select 1 as ok`
    return row?.ok === 1
  }

  async createSeller(email: string, displayName: string): Promise<SellerView> {
    return this.sql.begin(async (transaction) => {
      const [user] = await transaction<{ id: string }[]>`
        insert into users (email, display_name, role)
        values (${email}, ${displayName}, 'seller')
        returning id
      `
      const [profile] = await transaction<SellerView[]>`
        insert into seller_profiles (user_id)
        values (${user.id})
        returning id, onboarding_status, has_payout_method, whop_company_id,
          last_account_link_url, ${email}::text as email, ${displayName}::text as display_name
      `
      return profile
    })
  }

  async setSellerCompany(sellerId: string, companyId: string): Promise<void> {
    await this.sql`
      update seller_profiles set whop_company_id = ${companyId}, updated_at = now()
      where id = ${sellerId} and whop_company_id is null
    `
  }

  async setAccountLink(sellerId: string, url: string): Promise<void> {
    await this.sql`
      update seller_profiles
      set last_account_link_url = ${url}, onboarding_status = 'link_sent', updated_at = now()
      where id = ${sellerId}
    `
  }

  async getSeller(sellerId: string): Promise<SellerView | null> {
    const [seller] = await this.sql<SellerView[]>`
      select sp.id, u.email, u.display_name, sp.whop_company_id, sp.onboarding_status,
        sp.has_payout_method, sp.last_account_link_url
      from seller_profiles sp join users u on u.id = sp.user_id
      where sp.id = ${sellerId}
    `
    return seller ?? null
  }

  async listListings(): Promise<ListingView[]> {
    return this.sql<ListingView[]>`
      select l.id, l.title, l.description, l.price_cents, l.currency,
        u.display_name as seller_name
      from listings l
      join seller_profiles sp on sp.id = l.seller_id
      join users u on u.id = sp.user_id
      where l.status = 'active'
      order by l.created_at, l.id
    `
  }

  async createOrder(listingId: string, buyerEmail: string): Promise<OrderDraft | null> {
    return this.sql.begin(async (transaction) => {
      const [listing] = await transaction<
        { currency: string; price_cents: number; seller_id: string }[]
      >`
        select seller_id, price_cents, currency from listings
        where id = ${listingId} and status = 'active'
      `
      if (!listing) return null

      const [buyer] = await transaction<{ id: string; role: string }[]>`
        insert into users (email, display_name, role)
        values (${buyerEmail}, ${buyerEmail.split('@')[0]}, 'buyer')
        on conflict (email) do update set email = excluded.email
        returning id, role
      `
      if (buyer.role !== 'buyer') throw new Error('Email belongs to a non-buyer account')

      const [order] = await transaction<OrderDraft[]>`
        insert into orders (listing_id, buyer_id, seller_id, amount_cents, currency)
        values (${listingId}, ${buyer.id}, ${listing.seller_id}, ${listing.price_cents}, ${listing.currency})
        returning id, amount_cents, currency
      `
      return order
    })
  }

  async setCheckout(orderId: string, checkoutId: string): Promise<void> {
    await this.sql`
      update orders set whop_checkout_config_id = ${checkoutId}, updated_at = now()
      where id = ${orderId} and whop_checkout_config_id is null
    `
  }

  async getOrder(orderId: string): Promise<Record<string, unknown> | null> {
    const [order] = await this.sql<Record<string, unknown>[] >`
      select o.*, l.title as listing_title, buyer.email as buyer_email,
        seller_user.display_name as seller_name,
        coalesce((select jsonb_agg(to_jsonb(oe) order by oe.created_at) from order_events oe where oe.order_id = o.id), '[]') as events,
        coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from submissions s where s.order_id = o.id), '[]') as submissions
      from orders o
      join listings l on l.id = o.listing_id
      join users buyer on buyer.id = o.buyer_id
      join seller_profiles sp on sp.id = o.seller_id
      join users seller_user on seller_user.id = sp.user_id
      where o.id = ${orderId}
    `
    return order ?? null
  }

  async transitionOrder(input: {
    actor: Actor
    expected: OrderStatus[]
    note?: string
    orderId: string
    to: OrderStatus
    webhookEventId?: string
  }): Promise<TransitionResult | null> {
    return this.sql.begin(async (transaction) => {
      const [order] = await transaction<{ status: OrderStatus }[]>`
        select status from orders where id = ${input.orderId} for update
      `
      if (!order) return null
      const applied = input.expected.includes(order.status) && order.status !== input.to
      if (applied) {
        await transaction`
          update orders set status = ${input.to}, updated_at = now()
          where id = ${input.orderId} and status = ${order.status}
        `
      }
      await appendTransition(transaction, {
        ...input,
        applied,
        from: order.status,
        note: input.note ?? (applied ? undefined : 'Rejected: unexpected current state'),
      })
      return { applied, currentStatus: applied ? input.to : order.status, orderId: input.orderId }
    })
  }

  async recordPaymentSucceeded(input: {
    orderId: string
    paymentId: string
    webhookEventId: string
    whopUserId?: string
  }): Promise<TransitionResult | null> {
    return this.sql.begin(async (transaction) => {
      const [order] = await transaction<{ buyer_id: string; status: OrderStatus }[]>`
        select buyer_id, status from orders where id = ${input.orderId} for update
      `
      if (!order) return null
      const applied = order.status === 'pending_payment'
      if (applied) {
        await transaction`
          update orders set status = 'paid', whop_payment_id = ${input.paymentId},
            paid_at = now(), updated_at = now()
          where id = ${input.orderId} and status = 'pending_payment'
        `
        if (input.whopUserId) {
          await transaction`
            update users set whop_user_id = ${input.whopUserId}
            where id = ${order.buyer_id} and (whop_user_id is null or whop_user_id = ${input.whopUserId})
          `
        }
      }
      await appendTransition(transaction, {
        actor: 'webhook', applied, from: order.status, orderId: input.orderId, to: 'paid',
        webhookEventId: input.webhookEventId,
        note: applied ? `Whop payment ${input.paymentId}` : 'Rejected: unexpected current state',
      })
      return { applied, currentStatus: applied ? 'paid' : order.status, orderId: input.orderId }
    })
  }

  async createSubmission(orderId: string, contentUrl: string | null, note: string | null): Promise<TransitionResult | null> {
    return this.sql.begin(async (transaction) => {
      const [order] = await transaction<{ seller_id: string; status: OrderStatus }[]>`
        select seller_id, status from orders where id = ${orderId} for update
      `
      if (!order) return null
      const applied = order.status === 'in_progress'
      if (applied) {
        await transaction`
          insert into submissions (order_id, seller_id, content_url, note)
          values (${orderId}, ${order.seller_id}, ${contentUrl}, ${note})
        `
        await transaction`update orders set status = 'delivered', updated_at = now() where id = ${orderId}`
      }
      await appendTransition(transaction, {
        actor: 'seller', applied, from: order.status, orderId, to: 'delivered',
        note: applied ? 'Deliverable submitted' : 'Rejected: order is not in progress',
      })
      return { applied, currentStatus: applied ? 'delivered' : order.status, orderId }
    })
  }

  async reviewSubmission(orderId: string, _action: 'reject'): Promise<TransitionResult | null> {
    return this.sql.begin(async (transaction) => {
      const [order] = await transaction<{ status: OrderStatus }[]>`
        select status from orders where id = ${orderId} for update
      `
      if (!order) return null
      const applied = order.status === 'delivered'
      if (applied) {
        await transaction`
          update submissions set status = 'rejected'
          where id = (select id from submissions where order_id = ${orderId} order by created_at desc limit 1)
        `
        await transaction`update orders set status = 'in_progress', updated_at = now() where id = ${orderId}`
      }
      await appendTransition(transaction, {
        actor: 'buyer', applied, from: order.status, orderId, to: 'in_progress',
        note: applied ? 'Deliverable rejected for rework' : 'Rejected: order is not delivered',
      })
      return { applied, currentStatus: applied ? 'in_progress' : order.status, orderId }
    })
  }

  async approveAndCreatePayout(orderId: string): Promise<PayoutIntent | null> {
    return this.sql.begin(async (transaction) => {
      const [order] = await transaction<
        { amount_cents: number; currency: string; seller_id: string; status: OrderStatus; whop_company_id: string | null }[]
      >`
        select o.status, o.amount_cents, o.currency, o.seller_id, sp.whop_company_id
        from orders o join seller_profiles sp on sp.id = o.seller_id
        where o.id = ${orderId} for update of o
      `
      if (!order) return null
      const applied = order.status === 'delivered'
      if (applied) {
        if (!order.whop_company_id) throw new Error('Seller has no connected Whop company')
        await transaction`
          update submissions set status = 'approved'
          where id = (select id from submissions where order_id = ${orderId} order by created_at desc limit 1)
        `
        await transaction`
          update orders set status = 'completed', completed_at = now(), updated_at = now()
          where id = ${orderId} and status = 'delivered'
        `
      }
      await appendTransition(transaction, {
        actor: 'buyer', applied, from: order.status, orderId, to: 'completed',
        note: applied ? 'Deliverable approved' : 'Rejected: order is not delivered',
      })
      if (!applied && !['completed', 'payout_pending', 'paid_out', 'payout_failed'].includes(order.status)) {
        return null
      }

      const [payout] = await transaction<
        { amount_cents: number; currency: string; id: string; idempotency_key: string; status: string; whop_transfer_id: string | null }[]
      >`
        insert into payouts (order_id, seller_id, amount_cents, currency)
        values (${orderId}, ${order.seller_id}, ${order.amount_cents}, ${order.currency})
        on conflict (order_id) do update set order_id = excluded.order_id
        returning id, amount_cents, currency, idempotency_key::text, status, whop_transfer_id
      `
      if (!order.whop_company_id) throw new Error('Seller has no connected Whop company')
      const [claim] = await transaction<{ id: string }[]>`
        update payouts set status = 'processing', failure_reason = null
        where id = ${payout.id} and status = 'pending' and whop_transfer_id is null
        returning id
      `
      return {
        ...payout,
        order_id: orderId,
        shouldTransfer: Boolean(claim),
        whop_company_id: order.whop_company_id,
      }
    })
  }

  async markPayoutProcessing(payoutId: string, orderId: string, transferId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        update payouts set status = 'processing', whop_transfer_id = ${transferId}, failure_reason = null
        where id = ${payoutId} and status = 'processing' and whop_transfer_id is null
      `
      const [order] = await transaction<{ status: OrderStatus }[]>`
        select status from orders where id = ${orderId} for update
      `
      if (order) {
        const applied = order.status === 'completed'
        if (applied) await transaction`update orders set status = 'payout_pending', updated_at = now() where id = ${orderId}`
        await appendTransition(transaction, {
          actor: 'system', applied, from: order.status, orderId, to: 'payout_pending',
          note: applied ? `Transfer ${transferId} created` : 'Transfer already recorded',
        })
      }
    })
  }

  async markPayoutSucceeded(payoutId: string, orderId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        update payouts set status = 'succeeded', settled_at = now(), failure_reason = null
        where id = ${payoutId} and status in ('pending','processing')
      `
      const [order] = await transaction<{ status: OrderStatus }[]>`select status from orders where id = ${orderId} for update`
      if (order) {
        const applied = order.status === 'payout_pending'
        if (applied) await transaction`update orders set status = 'paid_out', updated_at = now() where id = ${orderId}`
        await appendTransition(transaction, { actor: 'system', applied, from: order.status, orderId, to: 'paid_out', note: 'Transfer retrieved successfully' })
      }
    })
  }

  async markPayoutFailed(payoutId: string, orderId: string, reason: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        update payouts set status = 'failed', failure_reason = ${reason}
        where id = ${payoutId} and status <> 'succeeded'
      `
      const [order] = await transaction<{ status: OrderStatus }[]>`select status from orders where id = ${orderId} for update`
      if (order) {
        const applied = ['completed', 'payout_pending'].includes(order.status)
        if (applied) await transaction`update orders set status = 'payout_failed', updated_at = now() where id = ${orderId}`
        await appendTransition(transaction, { actor: 'system', applied, from: order.status, orderId, to: 'payout_failed', note: reason })
      }
    })
  }

  async insertWebhook(input: WebhookInboxInput): Promise<WebhookInboxResult> {
    return this.sql.begin(async (transaction) => {
      const storedPayload = JSON.parse(
        JSON.stringify({ event: input.payload, raw_body: input.rawBody }),
      ) as postgres.JSONValue
      const [inserted] = await transaction<{ id: string }[]>`
        insert into webhook_events
          (whop_event_id, event_type, api_version_date, whop_company_id, payload)
        values (
          ${input.eventId}, ${input.eventType}, ${input.apiVersionDate ?? null},
          ${input.companyId ?? null}, ${transaction.json(storedPayload)}
        )
        on conflict (whop_event_id) do nothing
        returning id
      `
      if (inserted) return { duplicate: false, id: inserted.id }
      const [existing] = await transaction<{ id: string }[]>`
        update webhook_events set status = 'duplicate'
        where whop_event_id = ${input.eventId}
        returning id
      `
      return { duplicate: true, id: existing.id }
    })
  }

  async markWebhook(id: string, status: 'processed' | 'ignored' | 'error', error?: string): Promise<void> {
    await this.sql`
      update webhook_events set status = ${status}, error = ${error ?? null}, processed_at = now()
      where id = ${id} and status <> 'duplicate'
    `
  }

  async updateSellerReadiness(companyId: string, eventType: string): Promise<boolean> {
    const [updated] = await this.sql<{ id: string }[]>`
      update seller_profiles set
        has_payout_method = case when ${eventType} = 'payout_method.created' then true else has_payout_method end,
        onboarding_status = case
          when ${eventType} = 'payout_method.created' then 'payout_ready'
          when ${eventType} = 'verification.succeeded' then 'verified'
          when ${eventType} = 'payout_account.status_updated' and has_payout_method then 'payout_ready'
          else onboarding_status
        end,
        updated_at = now()
      where whop_company_id = ${companyId}
      returning id
    `
    return Boolean(updated)
  }

  async getDashboard(): Promise<Record<'orders' | 'sellers' | 'payouts' | 'webhooks' | 'errors', unknown[]>> {
    const [orders, sellers, payouts, webhooks, apiErrors, transitionErrors] = await Promise.all([
      this.sql`select o.id, l.title, u.email as buyer, o.amount_cents, o.currency, o.status, o.whop_payment_id, o.paid_at, o.completed_at, o.created_at from orders o join listings l on l.id = o.listing_id join users u on u.id = o.buyer_id order by o.created_at desc limit 50`,
      this.sql`select sp.id, u.display_name, u.email, sp.onboarding_status, sp.has_payout_method, sp.whop_company_id from seller_profiles sp join users u on u.id = sp.user_id order by sp.created_at desc`,
      this.sql`select id, order_id, amount_cents, currency, whop_transfer_id, status, failure_reason, created_at, settled_at from payouts order by created_at desc limit 50`,
      this.sql`select id, whop_event_id, event_type, status, error, received_at, processed_at from webhook_events order by received_at desc limit 50`,
      this.sql`select 'api' as source, id, method || ' ' || path as summary, status_code, error, created_at from api_request_log where error is not null or status_code >= 400 order by created_at desc limit 50`,
      this.sql`select 'transition' as source, id, from_status || ' → ' || to_status as summary, null::integer as status_code, note as error, created_at from order_events where applied = false order by created_at desc limit 50`,
    ])
    return { orders, sellers, payouts, webhooks, errors: [...apiErrors, ...transitionErrors].sort((a, b) => String((b as { created_at: string }).created_at).localeCompare(String((a as { created_at: string }).created_at))).slice(0, 50) }
  }
}
