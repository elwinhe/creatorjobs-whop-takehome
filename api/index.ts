import { waitUntil } from '@vercel/functions'
import { handle } from 'hono/vercel'
import { createRuntime } from '../server/index.ts'

const runtime = createRuntime(process.env, { defer: waitUntil })

export default handle(runtime.app)
