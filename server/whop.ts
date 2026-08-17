import Whop, { APIError, type APIPromise } from '@whop/sdk'
import type { Database } from './db.ts'
import type { ServerEnv } from './env.ts'

export type WhopCompany = { id: string }
export type WhopAccountLink = { expires_at: string; url: string }
export type WhopAccountLinkUseCase = 'account_onboarding' | 'payouts_portal'
export type WhopCheckout = { id: string; purchase_url: string | null }
export type WhopTransfer = { id: string }

export interface WhopGateway {
  createAccountLink(input: {
    companyId: string
    refreshUrl: string
    returnUrl: string
    useCase: WhopAccountLinkUseCase
  }): Promise<WhopAccountLink>
  createCheckout(input: {
    amountCents: number
    currency: string
    idempotencyKey: string
    orderId: string
    redirectUrl: string
  }): Promise<WhopCheckout>
  createCompany(input: {
    email: string
    parentCompanyId: string
    sellerId: string
    title: string
  }): Promise<WhopCompany>
  createTransfer(input: {
    amountCents: number
    currency: string
    destinationId: string
    idempotencyKey: string
    orderId: string
    originId: string
    payoutId: string
  }): Promise<WhopTransfer>
  retrieveTransfer(transferId: string): Promise<WhopTransfer>
  verifyWebhook(rawBody: string, headers: Record<string, string>): unknown
}

type RequestLog = {
  error?: string
  method: string
  path: string
  statusCode?: number
  whopRequestId?: string
}

function errorEvidence(error: unknown): Pick<RequestLog, 'error' | 'statusCode' | 'whopRequestId'> {
  if (error instanceof APIError) {
    return {
      error: error.message,
      statusCode: error.status,
      whopRequestId:
        error.headers?.get('x-request-id') ?? error.headers?.get('request-id') ?? undefined,
    }
  }

  return { error: error instanceof Error ? error.message : String(error) }
}

export function createWhopGateway(sql: Database, env: ServerEnv): WhopGateway {
  const client = new Whop({
    apiKey: env.WHOP_API_KEY,
    baseURL: env.WHOP_API_URL,
    maxRetries: 2,
    version: env.WHOP_API_VERSION,
    webhookKey: Buffer.from(env.WHOP_WEBHOOK_SECRET).toString('base64'),
  })

  async function record(entry: RequestLog): Promise<void> {
    await sql`
      insert into api_request_log (method, path, status_code, whop_request_id, error)
      values (
        ${entry.method}, ${entry.path}, ${entry.statusCode ?? null},
        ${entry.whopRequestId ?? null}, ${entry.error ?? null}
      )
    `
  }

  async function logged<T>(method: string, path: string, request: () => APIPromise<T>): Promise<T> {
    try {
      const { data, response } = await request().withResponse()
      await record({
        method,
        path,
        statusCode: response.status,
        whopRequestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined,
      })
      return data
    } catch (error) {
      try {
        await record({ method, path, ...errorEvidence(error) })
      } catch (logError) {
        console.error('Failed to persist Whop API error evidence', logError)
      }
      throw error
    }
  }

  return {
    createCompany: (input) =>
      logged('POST', '/companies', () =>
        client.companies.create({
          email: input.email,
          metadata: { seller_id: input.sellerId },
          parent_company_id: input.parentCompanyId,
          title: input.title,
        }),
      ),
    createAccountLink: (input) =>
      logged('POST', '/account_links', () =>
        client.accountLinks.create({
          company_id: input.companyId,
          refresh_url: input.refreshUrl,
          return_url: input.returnUrl,
          use_case: input.useCase,
        }),
      ),
    createCheckout: async (input) => {
      const checkout = await logged('POST', '/checkout_configurations', () =>
        client.checkoutConfigurations.create({
          account_id: env.WHOP_COMPANY_ID,
          'Idempotency-Key': input.idempotencyKey,
          metadata: { order_id: input.orderId },
          plan: {
            currency: input.currency,
            force_create_new_plan: true,
            initial_price: input.amountCents / 100,
            plan_type: 'one_time',
            release_method: 'buy_now',
          },
          redirect_url: input.redirectUrl,
        }),
      )
      return { id: checkout.id, purchase_url: checkout.purchase_url ?? null }
    },
    createTransfer: async (input) => {
      const transfer = await logged('POST', '/transfers', () =>
        client.transfers.create({
          amount: input.amountCents / 100,
          currency: input.currency,
          destination_id: input.destinationId,
          idempotence_key: input.idempotencyKey,
          'Idempotency-Key': input.idempotencyKey,
          metadata: { order_id: input.orderId, payout_id: input.payoutId },
          origin_id: input.originId,
          type: 'ledger',
        }),
      )
      if (!('id' in transfer)) throw new Error('Whop returned a non-ledger transfer response')
      return { id: transfer.id }
    },
    retrieveTransfer: (transferId) =>
      logged('GET', `/transfers/${transferId}`, () => client.transfers.retrieve(transferId)),
    verifyWebhook: (rawBody, headers) => client.webhooks.unwrap(rawBody, { headers }),
  }
}
