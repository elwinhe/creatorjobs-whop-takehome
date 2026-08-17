import { api } from './api'

export async function openPortalLink(path: string): Promise<void> {
  const popup = window.open('about:blank', '_blank')
  if (popup) popup.opener = null
  try {
    const link = await api<{ url: string }>(path, { method: 'POST' })
    if (popup) popup.location.href = link.url
    else window.open(link.url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    popup?.close()
    throw error
  }
}
