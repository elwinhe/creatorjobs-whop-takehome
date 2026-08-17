import postgres, { type Sql } from 'postgres'

export type Database = Sql<Record<string, unknown>>

export function createDatabase(databaseUrl: string, max = 10): Database {
  return postgres(databaseUrl, {
    idle_timeout: 20,
    max,
    prepare: true,
    transform: { undefined: null },
  })
}

export async function closeDatabase(sql: Database): Promise<void> {
  await sql.end({ timeout: 5 })
}
