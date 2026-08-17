import { Hono } from 'hono'
import { z } from 'zod'
import { approveOrderAndPay, processWebhookEvent } from './domain.js'
import type { MarketplaceRepository } from './repository.js'
import type { WhopGateway } from './whop.js'

const idSchema = z.string().uuid()
const sellerBodySchema = z.object({
  display_name: z.string().trim().min(2).max(100),
  email: z.email().transform((value) => value.toLowerCase()),
})
const orderBodySchema = z.object({
  buyer_email: z.email().transform((value) => value.toLowerCase()),
  listing_id: idSchema,
})
const submissionBodySchema = z.object({
  content_url: z.url().nullable().optional(),
  note: z.string().trim().max(2_000).nullable().optional(),
})

export type AppDependencies = {
  appBaseUrl: string
  defer?: (task: Promise<void>) => void
  environment: string
  platformCompanyId: string
  repository: MarketplaceRepository
  whop: WhopGateway
}

function defaultDefer(task: Promise<void>): void {
  void task.catch((error) => console.error('Deferred webhook processing failed', error))
}

async function jsonBody(context: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json()
  } catch {
    throw new z.ZodError([{ code: 'custom', input: undefined, message: 'Body must be valid JSON', path: [] }])
  }
}

export function createMarketplaceApp(dependencies: AppDependencies): Hono {
  const app = new Hono()
  const defer = dependencies.defer ?? defaultDefer

  app.onError((error, context) => {
    if (error instanceof z.ZodError) {
      return context.json({ error: 'Validation failed', issues: error.issues }, 400)
    }
    const code = objectCode(error)
    if (code === '23505') return context.json({ error: 'Resource already exists' }, 409)
    if (code === '23503') return context.json({ error: 'Related resource does not exist' }, 409)
    console.error(error)
    return context.json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500)
  })

  app.get('/api/health', async (context) => {
    try {
      const db = await dependencies.repository.ping()
      return context.json({ ok: db, db, environment: dependencies.environment, service: 'creatorjobs-api' }, db ? 200 : 503)
    } catch {
      return context.json({ ok: false, db: false, environment: dependencies.environment, service: 'creatorjobs-api' }, 503)
    }
  })

  app.post('/api/sellers', async (context) => {
    const body = sellerBodySchema.parse(await jsonBody(context))
    const seller = await dependencies.repository.createSeller(body.email, body.display_name)
    try {
      const company = await dependencies.whop.createCompany({
        email: body.email,
        parentCompanyId: dependencies.platformCompanyId,
        sellerId: seller.id,
        title: body.display_name,
      })
      await dependencies.repository.setSellerCompany(seller.id, company.id)
      return context.json(await dependencies.repository.getSeller(seller.id), 201)
    } catch (error) {
      return context.json(
        {
          error: error instanceof Error ? error.message : 'Whop company creation failed',
          seller_id: seller.id,
        },
        502,
      )
    }
  })

  app.get('/api/sellers/:id', async (context) => {
    const sellerId = idSchema.parse(context.req.param('id'))
    const seller = await dependencies.repository.getSeller(sellerId)
    return seller ? context.json(seller) : context.json({ error: 'Seller not found' }, 404)
  })

  app.post('/api/sellers/:id/account-link', async (context) => {
    const sellerId = idSchema.parse(context.req.param('id'))
    const seller = await dependencies.repository.getSeller(sellerId)
    if (!seller) return context.json({ error: 'Seller not found' }, 404)
    if (!seller.whop_company_id) return context.json({ error: 'Seller connected account is not ready' }, 409)
    const sellerUrl = `${dependencies.appBaseUrl.replace(/\/$/, '')}/seller?id=${seller.id}`
    let link: Awaited<ReturnType<WhopGateway['createAccountLink']>>
    try {
      link = await dependencies.whop.createAccountLink({
        companyId: seller.whop_company_id,
        refreshUrl: sellerUrl,
        returnUrl: sellerUrl,
        useCase: 'account_onboarding',
      })
    } catch {
      return context.json({ error: 'Whop account link creation failed' }, 502)
    }
    await dependencies.repository.setAccountLink(sellerId, link.url)
    return context.json(link)
  })

  app.post('/api/sellers/:id/payout-portal-link', async (context) => {
    const sellerId = idSchema.parse(context.req.param('id'))
    const seller = await dependencies.repository.getSeller(sellerId)
    if (!seller) return context.json({ error: 'Seller not found' }, 404)
    if (!seller.whop_company_id) return context.json({ error: 'Seller connected account is not ready' }, 409)
    const sellerUrl = `${dependencies.appBaseUrl.replace(/\/$/, '')}/seller?id=${seller.id}`
    try {
      const link = await dependencies.whop.createAccountLink({
        companyId: seller.whop_company_id,
        refreshUrl: sellerUrl,
        returnUrl: sellerUrl,
        useCase: 'payouts_portal',
      })
      return context.json(link)
    } catch {
      return context.json({ error: 'Whop payout portal link creation failed' }, 502)
    }
  })

  app.get('/api/listings', async (context) => context.json({ listings: await dependencies.repository.listListings() }))

  app.post('/api/orders', async (context) => {
    const body = orderBodySchema.parse(await jsonBody(context))
    const order = await dependencies.repository.createOrder(body.listing_id, body.buyer_email)
    if (!order) return context.json({ error: 'Active listing not found' }, 404)
    try {
      const redirectUrl = `${dependencies.appBaseUrl.replace(/\/$/, '')}/orders/${order.id}`
      const checkout = await dependencies.whop.createCheckout({
        amountCents: order.amount_cents,
        currency: order.currency,
        idempotencyKey: `checkout-${order.id}`,
        orderId: order.id,
        redirectUrl,
      })
      if (!checkout.purchase_url) throw new Error('Whop checkout did not return a purchase URL')
      await dependencies.repository.setCheckout(order.id, checkout.id)
      return context.json({ order_id: order.id, purchase_url: checkout.purchase_url }, 201)
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : 'Checkout creation failed', order_id: order.id },
        502,
      )
    }
  })

  app.get('/api/orders/:id', async (context) => {
    const orderId = idSchema.parse(context.req.param('id'))
    const order = await dependencies.repository.getOrder(orderId)
    return order ? context.json(order) : context.json({ error: 'Order not found' }, 404)
  })

  app.post('/api/orders/:id/accept', async (context) => {
    const orderId = idSchema.parse(context.req.param('id'))
    const result = await dependencies.repository.transitionOrder({ actor: 'seller', expected: ['paid'], orderId, to: 'in_progress' })
    return transitionResponse(context, result)
  })

  app.post('/api/orders/:id/submit', async (context) => {
    const orderId = idSchema.parse(context.req.param('id'))
    const body = submissionBodySchema.parse(await jsonBody(context))
    if (!body.content_url && !body.note) return context.json({ error: 'A content URL or note is required' }, 400)
    const result = await dependencies.repository.createSubmission(orderId, body.content_url ?? null, body.note ?? null)
    return transitionResponse(context, result)
  })

  app.post('/api/orders/:id/reject', async (context) => {
    const orderId = idSchema.parse(context.req.param('id'))
    const result = await dependencies.repository.reviewSubmission(orderId, 'reject')
    return transitionResponse(context, result)
  })

  app.post('/api/orders/:id/approve', async (context) => {
    const orderId = idSchema.parse(context.req.param('id'))
    try {
      const result = await approveOrderAndPay(
        dependencies.repository,
        dependencies.whop,
        dependencies.platformCompanyId,
        orderId,
      )
      return result ? context.json(result) : context.json({ error: 'Order cannot be approved' }, 409)
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : 'Payout failed' }, 502)
    }
  })

  app.post('/api/webhooks/whop', async (context) => {
    const rawBody = await context.req.text()
    const headers = Object.fromEntries(context.req.raw.headers.entries())
    let event: unknown
    try {
      event = dependencies.whop.verifyWebhook(rawBody, headers)
    } catch {
      return context.json({ error: 'Invalid webhook signature' }, 401)
    }
    const envelope = event as { api_version?: string; company_id?: string; id?: string; type?: string }
    const eventId = headers['webhook-id'] ?? envelope.id
    if (!eventId || !envelope.type) return context.json({ error: 'Invalid webhook envelope' }, 400)
    const inbox = await dependencies.repository.insertWebhook({
      apiVersionDate: headers['api-version-date'] ?? envelope.api_version,
      companyId: envelope.company_id,
      eventId,
      eventType: envelope.type,
      payload: event,
      rawBody,
    })
    if (!inbox.duplicate) defer(processWebhookEvent(dependencies.repository, inbox.id, event))
    return context.json({ accepted: true, duplicate: inbox.duplicate })
  })

  app.get('/api/dashboard', async (context) => context.json(await dependencies.repository.getDashboard()))

  app.notFound((context) => context.json({ error: 'Not found' }, 404))
  return app
}

function objectCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function transitionResponse(
  context: { json: (body: unknown, status?: 200 | 404 | 409) => Response },
  result: { applied: boolean; currentStatus: string } | null,
): Response {
  if (!result) return context.json({ error: 'Order not found' }, 404)
  if (!result.applied) return context.json({ error: 'Transition rejected', status: result.currentStatus }, 409)
  return context.json(result, 200)
}
