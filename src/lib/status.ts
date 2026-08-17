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

const onboardingLadder: Record<string, number> = { created: 0, link_sent: 1, verified: 2, payout_ready: 3 }

export function onboardingRank(status: unknown): number {
  return onboardingLadder[String(status)] ?? 0
}

export function kycComplete(status: unknown): boolean {
  return onboardingRank(status) >= onboardingLadder.verified
}
