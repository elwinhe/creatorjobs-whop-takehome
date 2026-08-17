import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configUrl = new URL('../vercel.json', import.meta.url)
const deployableHandlerUrl = new URL('../api/index.js', import.meta.url)
const sourceEntrypointUrl = new URL('./vercel.ts', import.meta.url)
const repositoryRoot = new URL('..', import.meta.url)

describe('Vercel routing contracts', () => {
  test('routes exact and nested API paths to the Hono function before the SPA fallback', async () => {
    const config = await Bun.file(configUrl).json() as {
      functions?: Record<string, unknown>
      rewrites: { destination: string; source: string }[]
    }

    expect(config.functions).toBeUndefined()

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
  })

  test('wires waitUntil into the runtime defer hook', async () => {
    const entrypoint = await Bun.file(sourceEntrypointUrl).text()

    expect(entrypoint).toContain("import { waitUntil } from '@vercel/functions'")
    expect(entrypoint).toContain("waitUntil(task.catch((error) => console.error('Deferred webhook processing failed', error)))")
    expect(entrypoint).toContain('createRuntime(process.env, { defer })')
    expect(entrypoint).not.toContain('createRuntime(process.env, { defer: waitUntil })')
    expect(entrypoint).toContain('const handler = handle(runtime.app)')
    expect(entrypoint).toContain('export default {\n  fetch(request: Request)')
    expect(entrypoint).not.toContain('export default handle(runtime.app)')
  })

  test('keeps the committed JavaScript handler in sync with its TypeScript source', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'creatorjobs-vercel-handler-'))

    try {
      const result = await Bun.build({
        entrypoints: [new URL('./vercel.ts', import.meta.url).pathname],
        format: 'esm',
        minify: { identifiers: false, syntax: true, whitespace: true },
        outdir: outputDirectory,
        packages: 'external',
        sourcemap: 'none',
        target: 'node',
      })

      expect(result.success).toBe(true)
      expect(result.outputs).toHaveLength(1)
      expect(await result.outputs[0].text()).toBe(await readFile(deployableHandlerUrl, 'utf8'))
    } finally {
      await rm(outputDirectory, { force: true, recursive: true })
    }
  })

  test('ships a self-contained JavaScript handler that Node 22 can import and invoke', async () => {
    const handler = await readFile(deployableHandlerUrl, 'utf8')
    const runtimeImports = [...handler.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)]
      .map((match) => match[1])

    expect(runtimeImports.some((specifier) => specifier.startsWith('.'))).toBe(false)
    expect(runtimeImports.some((specifier) => specifier.endsWith('.ts'))).toBe(false)
    expect(handler).not.toContain('../server/')

    const nodeMajor = Number(process.versions.node.split('.')[0])
    expect(nodeMajor).toBeGreaterThanOrEqual(22)

    const script = [
      `const module = await import(${JSON.stringify(deployableHandlerUrl.href)})`,
      "if (typeof module.default?.fetch !== 'function') throw new Error('Expected a Web Handler with a callable fetch method')",
      "const response = await module.default.fetch(new Request('http://localhost/api/not-found'))",
      "if (response.status !== 404) throw new Error(`Expected 404, received ${response.status}`)",
      "const body = await response.json()",
      "if (body.error !== 'Not found') throw new Error('Unexpected response body')",
    ].join(';')
    const subprocess = Bun.spawn({
      cmd: ['node', '--input-type=module', '--eval', script],
      cwd: repositoryRoot.pathname,
      env: { ...process.env, NODE_ENV: 'test' },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  test('fails closed when required production environment values are absent', async () => {
    const script = [
      `try { await import(${JSON.stringify(deployableHandlerUrl.href)}) }`,
      "catch (error) { process.stderr.write(`${error?.name ?? 'Error'}\\n`); process.exitCode = 2 }",
    ].join(' ')
    const subprocess = Bun.spawn({
      cmd: ['node', '--input-type=module', '--eval', script],
      cwd: repositoryRoot.pathname,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(stderr).toBe('ZodError\n')
  })
})
