import { z } from 'zod'

const baseEnvironmentSchema = z.object({
  APP_BASE_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  WHOP_API_KEY: z.string().min(1),
  WHOP_API_URL: z.url().default('https://sandbox-api.whop.com/api/v1'),
  WHOP_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-07-20'),
  WHOP_COMPANY_ID: z.string().startsWith('biz_'),
  WHOP_WEBHOOK_SECRET: z.string().min(1),
})

export function webhookSecrets(env: Pick<ServerEnv, 'WHOP_WEBHOOK_SECRET'>): string[] {
  return env.WHOP_WEBHOOK_SECRET.split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0)
}

const databaseEnvironmentSchema = baseEnvironmentSchema.pick({ DATABASE_URL: true })

export type ServerEnv = z.infer<typeof baseEnvironmentSchema>
export type DatabaseEnv = z.infer<typeof databaseEnvironmentSchema>

const testDefaults: ServerEnv = {
  APP_BASE_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://test:test@localhost:5432/creatorjobs_test',
  NODE_ENV: 'test',
  PORT: 3001,
  WHOP_API_KEY: 'test_key',
  WHOP_API_URL: 'https://sandbox-api.whop.com/api/v1',
  WHOP_API_VERSION: '2026-07-20',
  WHOP_COMPANY_ID: 'biz_test',
  WHOP_WEBHOOK_SECRET: 'test_webhook_secret',
}

export function parseServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const input = source.NODE_ENV === 'test' ? { ...testDefaults, ...source } : source
  return baseEnvironmentSchema.parse(input)
}

export function parseDatabaseEnv(source: NodeJS.ProcessEnv = process.env): DatabaseEnv {
  return databaseEnvironmentSchema.parse(source)
}

export function formatEnvError(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error)

  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}
