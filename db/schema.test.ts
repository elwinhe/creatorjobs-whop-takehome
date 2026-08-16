import { describe, expect, test } from 'bun:test'

const migrationUrl = new URL('./migrations/001_init.sql', import.meta.url)
const seedUrl = new URL('./seed.ts', import.meta.url)

describe('database contracts', () => {
  test('the initial migration defines exactly the nine marketplace tables', async () => {
    const source = await Bun.file(migrationUrl).text()
    const tables = [...source.matchAll(/create table\s+(\w+)/gi)].map((match) => match[1])

    expect(tables).toEqual([
      'users',
      'seller_profiles',
      'listings',
      'orders',
      'submissions',
      'payouts',
      'webhook_events',
      'order_events',
      'api_request_log',
    ])
  })

  test('the seed keeps deterministic actor and listing cardinalities', async () => {
    const source = await Bun.file(seedUrl).text()

    expect(source).toContain("'admin@creatorjobs.test'")
    expect(source.match(/'buyer\.(?:one|two)@creatorjobs\.test'/g)).toHaveLength(2)
    expect(source.match(/'seller\.(?:one|two)@creatorjobs\.test'/g)).toHaveLength(2)
    expect(source.match(/profile[A-B]:/g)).toHaveLength(2)
    expect(source.match(/listing[A-C]:/g)).toHaveLength(3)
    expect(source).toContain('on conflict do nothing')
  })
})
