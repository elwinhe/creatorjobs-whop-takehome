import { z } from 'zod'

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  WHOP_API_KEY: z.string().min(1).optional(),
  WHOP_API_URL: z.url().default('https://sandbox-api.whop.com/api/v1'),
  WHOP_COMPANY_ID: z.string().startsWith('biz_').optional(),
  WHOP_WEBHOOK_SECRET: z.string().min(1).optional(),
})

export const env = environmentSchema.parse(process.env)
