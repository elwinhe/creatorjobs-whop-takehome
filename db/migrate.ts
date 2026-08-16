import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../server/db.ts'
import { formatEnvError, parseServerEnv } from '../server/env.ts'

const migrationsDirectory = fileURLToPath(new URL('./migrations', import.meta.url))

async function migrate(): Promise<void> {
  const env = parseServerEnv()
  const sql = createDatabase(env.DATABASE_URL, 1)

  try {
    await sql`
      create table if not exists _migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `
    await sql`select pg_advisory_lock(hashtext('creatorjobs_migrations'))`

    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort()
    for (const name of files) {
      const source = await readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8')
      const checksum = createHash('sha256').update(source).digest('hex')
      const [existing] = await sql<{ checksum: string }[]>`
        select checksum from _migrations where name = ${name}
      `

      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Migration drift detected: ${name}`)
        console.log(`skip ${name}`)
        continue
      }

      await sql.begin(async (transaction) => {
        await transaction.unsafe(source)
        await transaction`insert into _migrations (name, checksum) values (${name}, ${checksum})`
      })
      console.log(`applied ${name}`)
    }
  } finally {
    try {
      await sql`select pg_advisory_unlock(hashtext('creatorjobs_migrations'))`
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
}

migrate().catch((error) => {
  console.error(`Migration failed: ${formatEnvError(error)}`)
  process.exitCode = 1
})
