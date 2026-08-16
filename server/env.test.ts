import { describe, expect, test } from 'bun:test'
import { parseDatabaseEnv, parseServerEnv } from './env.ts'

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

  test('database scripts validate only DATABASE_URL', () => {
    expect(parseDatabaseEnv({
      APP_BASE_URL: 'not-a-url',
      DATABASE_URL: 'postgres://database.example/creatorjobs',
      WHOP_COMPANY_ID: 'not-a-company-id',
    })).toEqual({
      DATABASE_URL: 'postgres://database.example/creatorjobs',
    })
    expect(() => parseDatabaseEnv({ WHOP_COMPANY_ID: 'not-a-company-id' })).toThrow()
  })

  test('server startup still requires every runtime integration value', () => {
    expect(() => parseServerEnv({
      DATABASE_URL: 'postgres://database.example/creatorjobs',
      NODE_ENV: 'production',
    })).toThrow()
  })
})
