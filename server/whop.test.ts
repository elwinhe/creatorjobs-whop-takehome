import { describe, expect, test } from 'bun:test'
import { Webhook } from 'standardwebhooks'
import { parseServerEnv, webhookSecrets } from './env.js'
import type { Database } from './db.js'
import { createWhopGateway } from './whop.js'

const sqlStub = (() => {
  throw new Error('database should not be touched by webhook verification')
}) as unknown as Database

function signedHeaders(rawSecret: string, eventId: string, body: string): Record<string, string> {
  const timestamp = new Date()
  const signer = new Webhook(Buffer.from(rawSecret).toString('base64'))
  return {
    'webhook-id': eventId,
    'webhook-signature': signer.sign(eventId, timestamp, body),
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
  }
}

describe('webhookSecrets', () => {
  test('splits comma-separated secrets and trims whitespace', () => {
    expect(webhookSecrets({ WHOP_WEBHOOK_SECRET: 'ws_a, ws_b ,ws_c' })).toEqual(['ws_a', 'ws_b', 'ws_c'])
  })

  test('single secret stays a one-element list', () => {
    expect(webhookSecrets({ WHOP_WEBHOOK_SECRET: 'ws_only' })).toEqual(['ws_only'])
  })

  test('ignores empty segments from trailing commas', () => {
    expect(webhookSecrets({ WHOP_WEBHOOK_SECRET: 'ws_a,,' })).toEqual(['ws_a'])
  })
})

describe('createWhopGateway verifyWebhook with multiple secrets', () => {
  const env = parseServerEnv({
    NODE_ENV: 'test',
    WHOP_WEBHOOK_SECRET: 'ws_platform_secret,ws_child_secret',
  } as NodeJS.ProcessEnv)
  const gateway = createWhopGateway(sqlStub, env)
  const body = JSON.stringify({ data: { id: 'pay_1' }, type: 'payment.succeeded' })

  test('accepts an event signed with the first secret', () => {
    const event = gateway.verifyWebhook(body, signedHeaders('ws_platform_secret', 'msg_first', body))
    expect(event).toMatchObject({ type: 'payment.succeeded' })
  })

  test('accepts an event signed with the second secret', () => {
    const event = gateway.verifyWebhook(body, signedHeaders('ws_child_secret', 'msg_second', body))
    expect(event).toMatchObject({ type: 'payment.succeeded' })
  })

  test('rejects an event signed with an unknown secret', () => {
    expect(() => gateway.verifyWebhook(body, signedHeaders('ws_attacker', 'msg_bad', body))).toThrow()
  })
})
