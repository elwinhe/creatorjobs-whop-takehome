import { describe, expect, test } from 'bun:test'

const configUrl = new URL('../vercel.json', import.meta.url)
const catchAllUrl = new URL('../api/[...path].ts', import.meta.url)
const entrypointUrl = new URL('../api/index.ts', import.meta.url)

describe('Vercel routing contracts', () => {
  test('filesystem functions handle API paths before the SPA fallback', async () => {
    const config = await Bun.file(configUrl).json() as {
      rewrites: { destination: string; source: string }[]
    }

    expect(config.rewrites).toEqual([{ source: '/:path*', destination: '/index.html' }])
    expect(await Bun.file(catchAllUrl).text()).toContain("export { default } from './index.ts'")
  })

  test('extends deferred webhook processing with the Vercel lifecycle', async () => {
    const entrypoint = await Bun.file(entrypointUrl).text()

    expect(entrypoint).toContain("import { waitUntil } from '@vercel/functions'")
    expect(entrypoint).toContain('createRuntime(process.env, { defer: waitUntil })')
  })
})
