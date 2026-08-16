import { serve } from '@hono/node-server'
import { createMarketplaceApp } from './app.ts'
import { closeDatabase, createDatabase } from './db.ts'
import { formatEnvError, parseServerEnv } from './env.ts'
import { PostgresMarketplaceRepository } from './repository.ts'
import { createWhopGateway } from './whop.ts'

export function createRuntime(source: NodeJS.ProcessEnv = process.env) {
  const env = parseServerEnv(source)
  const database = createDatabase(env.DATABASE_URL)
  const repository = new PostgresMarketplaceRepository(database)
  const whop = createWhopGateway(database, env)
  const app = createMarketplaceApp({
    appBaseUrl: env.APP_BASE_URL,
    environment: env.NODE_ENV,
    platformCompanyId: env.WHOP_COMPANY_ID,
    repository,
    whop,
  })

  return { app, close: () => closeDatabase(database), env }
}

export async function startServer(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = createRuntime(source)
  const server = serve({ fetch: runtime.app.fetch, port: runtime.env.PORT })
  console.log(`CreatorJobs API listening on http://localhost:${runtime.env.PORT}`)

  const shutdown = async () => {
    server.close()
    await runtime.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (import.meta.main) {
  startServer().catch((error) => {
    console.error(`Server failed to start: ${formatEnvError(error)}`)
    process.exitCode = 1
  })
}
