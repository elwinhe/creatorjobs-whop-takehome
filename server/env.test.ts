import { describe, expect, test } from 'bun:test'
import { parseServerEnv } from './env.ts'

describe('server environment', () => {
  test('rejects a production environment with missing secrets', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'production' })).toThrow()
  })

  test('provides non-secret local defaults only in test mode', () => {
    const env = parseServerEnv({ NODE_ENV: 'test' })
    expect(env.NODE_ENV).toBe('test')
    expect(env.WHOP_COMPANY_ID).toBe('biz_test')
    expect(env.DATABASE_URL).toContain('creatorjobs_test')
  })
})
