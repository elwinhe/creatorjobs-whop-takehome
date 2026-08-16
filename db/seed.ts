import { createDatabase } from '../server/db.ts'
import { formatEnvError, parseServerEnv } from '../server/env.ts'

const ids = {
  admin: '10000000-0000-4000-8000-000000000001',
  buyerA: '10000000-0000-4000-8000-000000000002',
  buyerB: '10000000-0000-4000-8000-000000000003',
  sellerA: '10000000-0000-4000-8000-000000000004',
  sellerB: '10000000-0000-4000-8000-000000000005',
  profileA: '20000000-0000-4000-8000-000000000001',
  profileB: '20000000-0000-4000-8000-000000000002',
  listingA: '30000000-0000-4000-8000-000000000001',
  listingB: '30000000-0000-4000-8000-000000000002',
  listingC: '30000000-0000-4000-8000-000000000003',
} as const

async function seed(): Promise<void> {
  const env = parseServerEnv()
  const sql = createDatabase(env.DATABASE_URL, 1)

  try {
    await sql.begin(async (transaction) => {
      await transaction`
        insert into users (id, email, display_name, role) values
          (${ids.admin}, 'admin@creatorjobs.test', 'Demo Operator', 'admin'),
          (${ids.buyerA}, 'buyer.one@creatorjobs.test', 'Maya Buyer', 'buyer'),
          (${ids.buyerB}, 'buyer.two@creatorjobs.test', 'Noah Buyer', 'buyer'),
          (${ids.sellerA}, 'seller.one@creatorjobs.test', 'Avery Studio', 'seller'),
          (${ids.sellerB}, 'seller.two@creatorjobs.test', 'Morgan Creative', 'seller')
        on conflict do nothing
      `
      await transaction`
        insert into seller_profiles (id, user_id, metadata) values
          (${ids.profileA}, ${ids.sellerA}, ${transaction.json({ seed: true })}),
          (${ids.profileB}, ${ids.sellerB}, ${transaction.json({ seed: true })})
        on conflict do nothing
      `
      await transaction`
        insert into listings (id, seller_id, title, description, price_cents, currency) values
          (${ids.listingA}, ${ids.profileA}, 'Short-form launch edit', 'A polished 30–45 second launch cut.', 25000, 'usd'),
          (${ids.listingB}, ${ids.profileA}, 'Three social cutdowns', 'Three platform-ready edits from supplied footage.', 42000, 'usd'),
          (${ids.listingC}, ${ids.profileB}, 'Creator product photography', 'A ten-image studio product set.', 68000, 'usd')
        on conflict do nothing
      `
    })
    console.log('Seed complete: 5 users, 2 seller profiles, 3 listings')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

seed().catch((error) => {
  console.error(`Seed failed: ${formatEnvError(error)}`)
  process.exitCode = 1
})
