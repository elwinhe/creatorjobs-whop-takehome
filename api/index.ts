import { handle } from 'hono/vercel'
import { createRuntime } from '../server/index.ts'

const runtime = createRuntime()

export default handle(runtime.app)
