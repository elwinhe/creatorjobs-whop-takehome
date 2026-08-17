import { waitUntil } from '@vercel/functions'
import { handle } from 'hono/vercel'
import { createRuntime } from './index.ts'

function defer(task: Promise<void>): void {
  waitUntil(task.catch((error) => console.error('Deferred webhook processing failed', error)))
}

const runtime = createRuntime(process.env, { defer })
const handler = handle(runtime.app)

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
