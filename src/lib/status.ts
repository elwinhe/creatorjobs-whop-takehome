const tones: Record<string, 'danger' | 'success'> = {
  verified: 'success',
  payout_ready: 'success',
  paid_out: 'success',
  succeeded: 'success',
  processed: 'success',
  payout_failed: 'danger',
  failed: 'danger',
  error: 'danger',
}

export function statusTone(status: unknown): 'danger' | 'neutral' | 'success' {
  return tones[String(status)] ?? 'neutral'
}
