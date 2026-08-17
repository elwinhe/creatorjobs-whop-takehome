const tones: Record<string, 'accent' | 'danger' | 'success'> = {
  verified: 'success',
  payout_ready: 'success',
  paid_out: 'success',
  succeeded: 'success',
  processed: 'success',
  link_sent: 'accent',
  payout_failed: 'danger',
  failed: 'danger',
  error: 'danger',
}

export function statusTone(status: unknown): 'accent' | 'danger' | 'neutral' | 'success' {
  return tones[String(status)] ?? 'neutral'
}
