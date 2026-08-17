import { ArrowUpRight, Check, Circle, LoaderCircle } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Surface } from '../components/ui/Surface'
import { api, shortId } from '../lib/api'

type Seller = {
  display_name: string
  email: string
  has_payout_method: boolean
  id: string
  last_account_link_url: string | null
  onboarding_status: string
  whop_company_id: string | null
}

const statusRank: Record<string, number> = { created: 0, link_sent: 1, verified: 2, payout_ready: 3 }
const setupSteps = ['Connected account created', 'Onboarding link opened', 'Identity verified']

export function SellerScreen() {
  const initialId = new URLSearchParams(window.location.search).get('id')
  const [seller, setSeller] = useState<Seller | null>(null)
  const [displayName, setDisplayName] = useState('Northstar Studio')
  const [email, setEmail] = useState('creator@northstar.test')
  const [busy, setBusy] = useState(false)
  const [payoutBusy, setPayoutBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (id: string) => {
    try { setSeller(await api<Seller>(`/api/sellers/${id}`)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Seller lookup failed') }
  }, [])

  useEffect(() => { if (initialId) void load(initialId) }, [initialId, load])

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const created = await api<Seller>('/api/sellers', { body: JSON.stringify({ display_name: displayName, email }), method: 'POST' })
      setSeller(created)
      window.history.replaceState({}, '', `/seller?id=${created.id}`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Seller creation failed') }
    finally { setBusy(false) }
  }

  async function accountLink() {
    if (!seller) return
    setBusy(true); setError(null)
    const popup = window.open('about:blank', '_blank')
    if (popup) popup.opener = null
    try {
      const link = await api<{ url: string }>(`/api/sellers/${seller.id}/account-link`, { method: 'POST' })
      if (popup) popup.location.href = link.url
      else window.open(link.url, '_blank', 'noopener,noreferrer')
      await load(seller.id)
    } catch (reason) {
      popup?.close()
      setError(reason instanceof Error ? reason.message : 'Account link failed')
    } finally { setBusy(false) }
  }

  async function payoutPortal() {
    if (!seller) return
    setPayoutBusy(true); setError(null)
    try {
      const link = await api<{ url: string }>(`/api/sellers/${seller.id}/payout-portal-link`, { method: 'POST' })
      window.location.assign(link.url)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Payout portal link failed') }
    finally { setPayoutBusy(false) }
  }

  const currentRank = seller ? (statusRank[seller.onboarding_status] ?? 0) : 0
  const kycComplete = Boolean(seller) && currentRank >= statusRank.verified
  return (
    <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
      <section>
        <h1 className="mt-5 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">Seller onboarding without the black box.</h1>
        <p className="mt-5 max-w-xl text-lg leading-8 text-muted-foreground">Create the local seller, provision their Whop company, then resume hosted KYC whenever a link expires.</p>
        {!seller && (
          <form className="mt-8 grid gap-4" onSubmit={create}>
            <label><span className="mb-2 block text-sm font-medium">Studio or creator name</span><Input onChange={(event) => setDisplayName(event.target.value)} required value={displayName} /></label>
            <label><span className="mb-2 block text-sm font-medium">Contact email</span><Input onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
            <Button className="mt-2 w-fit" disabled={busy} type="submit">{busy && <LoaderCircle className="size-4 animate-spin" />} Create seller</Button>
          </form>
        )}
        {error && <p className="mt-5 rounded-md bg-negative-subtle px-4 py-3 text-sm font-medium text-negative shadow-error" role="alert">{error}</p>}
      </section>

      <Surface className="flex flex-col overflow-hidden p-2">
        <div className="flex-1 rounded-sm bg-rail p-6 text-white sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-rail-muted">Readiness record</p><h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{seller?.display_name ?? 'Awaiting seller'}</h2></div>
            <Badge tone={kycComplete ? 'success' : 'accent'}>{seller?.onboarding_status ?? 'not started'}</Badge>
          </div>
          <dl className="mt-7 grid gap-4 border-y border-white/10 py-5 font-mono text-xs sm:grid-cols-2">
            <div className="min-w-0"><dt className="text-rail-muted">Local seller</dt><dd className="mt-1 break-all text-white" title={seller?.id}>{shortId(seller?.id)}</dd></div>
            <div className="min-w-0"><dt className="text-rail-muted">Whop company</dt><dd className="mt-1 break-all text-white" title={seller?.whop_company_id ?? ''}>{shortId(seller?.whop_company_id)}</dd></div>
          </dl>
          <ol className="mt-7 space-y-1">
            {setupSteps.map((label, index) => {
              const complete = Boolean(seller) && currentRank >= index
              return <li className="flex min-h-12 items-center gap-3" key={label}>{complete ? <span className="grid size-7 place-items-center rounded-full bg-primary text-white"><Check className="size-3.5" /></span> : <Circle className="size-7 text-white/20" />}<span className={complete ? 'text-white' : 'text-rail-muted'}>{label}</span></li>
            })}
          </ol>
          {seller && <div className="mt-7 flex flex-wrap gap-3">
            {!kycComplete && <Button className="w-full sm:w-auto" disabled={busy || payoutBusy || !seller.whop_company_id} onClick={accountLink} variant="secondary">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUpRight className="size-4" />} Start / resume KYC</Button>}
            {kycComplete && <Button className="w-full sm:w-auto" disabled={busy || payoutBusy || !seller.whop_company_id} onClick={payoutPortal}>{payoutBusy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUpRight className="size-4" />} Manage withdrawals</Button>}
          </div>}
        </div>
      </Surface>
    </div>
  )
}
