import { describe, expect, test } from 'bun:test'

const configUrl = new URL('../vercel.json', import.meta.url)
const catchAllUrl = new URL('../api/[...path].ts', import.meta.url)
const entrypointUrl = new URL('../api/index.ts', import.meta.url)

describe('Vercel routing contracts', () => {
  test('routes exact and nested API paths to the Hono function before the SPA fallback', async () => {
    const config = await Bun.file(configUrl).json() as {
      functions: Record<string, { includeFiles: string }>
      rewrites: { destination: string; source: string }[]
    }

    expect(config.functions).toEqual({
      'api/**/*.ts': { includeFiles: 'server/**' },
    })

    expect(config.rewrites).toEqual([
      { source: '/api', destination: '/api/index' },
      { source: '/api/:path*', destination: '/api/index' },
      { source: '/((?!api(?:/|$)).*)', destination: '/index.html' },
    ])

    const spaFallback = config.rewrites.at(-1)
    expect(spaFallback?.source).not.toBe('/:path*')

    const spaMatcher = new RegExp(`^${spaFallback?.source}$`)
    expect(spaMatcher.test('/')).toBe(true)
    expect(spaMatcher.test('/dashboard')).toBe(true)
    expect(spaMatcher.test('/apian')).toBe(true)
    expect(spaMatcher.test('/api')).toBe(false)
    expect(spaMatcher.test('/api/health')).toBe(false)
    expect(await Bun.file(catchAllUrl).text()).toContain("export { default } from './index.ts'")
  })

  test('wires waitUntil into the runtime defer hook', async () => {
    const entrypoint = await Bun.file(entrypointUrl).text()

    expect(entrypoint).toContain("import { waitUntil } from '@vercel/functions'")
    expect(entrypoint).toContain("waitUntil(task.catch((error) => console.error('Deferred webhook processing failed', error)))")
    expect(entrypoint).toContain('createRuntime(process.env, { defer })')
    expect(entrypoint).not.toContain('createRuntime(process.env, { defer: waitUntil })')
  })
})
