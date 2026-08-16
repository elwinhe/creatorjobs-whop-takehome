import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { env } from './env.ts'

const app = new Hono()

app.get('/api/health', (context) =>
  context.json({
    environment: env.NODE_ENV,
    service: 'creatorjobs-api',
    status: 'ok',
  }),
)

serve({
  fetch: app.fetch,
  port: env.PORT,
})

console.log(`CreatorJobs API listening on http://localhost:${env.PORT}`)
