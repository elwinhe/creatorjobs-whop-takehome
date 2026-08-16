export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body
}

export function money(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', { currency: currency.toUpperCase(), style: 'currency' }).format(cents / 100)
}

export function shortId(value: unknown): string {
  const text = String(value ?? '—')
  return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-5)}` : text
}
