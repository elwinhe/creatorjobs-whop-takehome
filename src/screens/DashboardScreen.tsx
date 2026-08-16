import { ArrowUpRight, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Surface } from '../components/ui/Surface'
import { api, money, shortId } from '../lib/api'

type Row = Record<string, unknown>
type Dashboard = { errors: Row[]; orders: Row[]; payouts: Row[]; sellers: Row[]; webhooks: Row[] }

function Panel({ children, count, title }: { children: ReactNode; count: number; title: string }) {
  return <Surface className="overflow-hidden"><div className="flex items-center justify-between border-b border-border px-5 py-4"><h2 className="font-semibold tracking-[-0.02em]">{title}</h2><span className="font-mono text-xs text-muted-foreground" data-numeric>{String(count).padStart(2, '0')}</span></div><div className="divide-y divide-border">{children}</div></Surface>
}

function Empty() { return <p className="px-5 py-8 text-sm text-muted-foreground">No local evidence yet.</p> }
function Meta({ children }: { children: ReactNode }) { return <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground">{children}</span> }

export function DashboardScreen() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busySeller, setBusySeller] = useState<string | null>(null)
  const load = useCallback(() => api<Dashboard>('/api/dashboard').then(setData).catch((reason: Error) => setError(reason.message)), [])
  useEffect(() => { void load() }, [load])

  async function regenerate(id: string) {
    setBusySeller(id); setError(null)
    try { const link = await api<{ url: string }>(`/api/sellers/${id}/account-link`, { method: 'POST' }); window.open(link.url, '_blank', 'noopener,noreferrer'); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Link regeneration failed') }
    finally { setBusySeller(null) }
  }

  if (!data) return <div className="grid min-h-64 place-items-center">{error ?? <LoaderCircle className="size-6 animate-spin text-primary" />}</div>
  return (
    <>
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><Badge tone="accent">Local database only</Badge><h1 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">Operations, with receipts.</h1><p className="mt-3 text-muted-foreground">Five panels. Every answer comes from CreatorJobs’ own evidence trail.</p></div>
        <Button onClick={() => void load()} variant="secondary"><RefreshCw className="size-4" /> Refresh</Button>
      </div>
      {error && <p className="mb-5 rounded-md bg-negative-subtle px-4 py-3 text-sm text-negative" role="alert">{error}</p>}
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel count={data.orders.length} title="Orders">
          {data.orders.length === 0 ? <Empty /> : data.orders.map((row) => <a className="flex min-h-20 items-center justify-between gap-4 px-5 py-4 transition-[background-color] hover:bg-foreground/[0.025]" href={`/orders/${row.id}`} key={String(row.id)}><div><p className="font-medium">{String(row.title)}</p><p className="mt-1"><Meta>{shortId(row.whop_payment_id)} · {String(row.buyer)}</Meta></p></div><div className="text-right"><Badge tone="neutral">{String(row.status)}</Badge><p className="mt-2 text-sm font-semibold" data-numeric>{money(Number(row.amount_cents), String(row.currency))}</p></div></a>)}
        </Panel>
        <Panel count={data.sellers.length} title="Sellers">
          {data.sellers.length === 0 ? <Empty /> : data.sellers.map((row) => <div className="flex min-h-20 flex-wrap items-center justify-between gap-4 px-5 py-4" key={String(row.id)}><div><p className="font-medium">{String(row.display_name)}</p><p className="mt-1"><Meta>{shortId(row.whop_company_id)} · {row.has_payout_method ? 'PAYOUT READY' : 'PAYOUT PENDING'}</Meta></p></div><div className="flex items-center gap-2"><Badge tone={row.onboarding_status === 'payout_ready' ? 'success' : 'neutral'}>{String(row.onboarding_status)}</Badge><Button aria-label={`Regenerate account link for ${row.display_name}`} disabled={busySeller === row.id || !row.whop_company_id} onClick={() => regenerate(String(row.id))} size="sm" variant="ghost">{busySeller === row.id ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUpRight className="size-4" />} Link</Button></div></div>)}
        </Panel>
        <Panel count={data.payouts.length} title="Payouts">
          {data.payouts.length === 0 ? <Empty /> : data.payouts.map((row) => <div className="flex min-h-20 items-center justify-between gap-4 px-5 py-4" key={String(row.id)}><div><p className="font-medium" data-numeric>{money(Number(row.amount_cents), String(row.currency))}</p><p className="mt-1"><Meta>{shortId(row.whop_transfer_id)} · ORDER {shortId(row.order_id)}</Meta></p>{Boolean(row.failure_reason) && <p className="mt-2 text-sm text-negative">{String(row.failure_reason)}</p>}</div><Badge tone={row.status === 'succeeded' ? 'success' : row.status === 'failed' ? 'danger' : 'neutral'}>{String(row.status)}</Badge></div>)}
        </Panel>
        <Panel count={data.webhooks.length} title="Webhook feed">
          {data.webhooks.length === 0 ? <Empty /> : data.webhooks.map((row) => <div className="flex min-h-20 items-center justify-between gap-4 px-5 py-4" key={String(row.id)}><div><p className="font-medium">{String(row.event_type)}</p><p className="mt-1"><Meta>{shortId(row.whop_event_id)} · {new Date(String(row.received_at)).toLocaleString()}</Meta></p>{Boolean(row.error) && <p className="mt-2 text-sm text-negative">{String(row.error)}</p>}</div><Badge tone={row.status === 'processed' ? 'success' : row.status === 'error' ? 'danger' : 'neutral'}>{String(row.status)}</Badge></div>)}
        </Panel>
        <div className="xl:col-span-2">
          <Panel count={data.errors.length} title="Errors & rejected transitions">
            {data.errors.length === 0 ? <Empty /> : data.errors.map((row) => <div className="grid min-h-20 grid-cols-[auto_1fr] gap-4 px-5 py-4" key={`${row.source}-${row.id}`}><span className="grid size-10 place-items-center rounded-md bg-negative-subtle text-negative"><CircleAlert className="size-4" /></span><div><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{String(row.summary)}</p><Meta>{String(row.source)}</Meta></div><p className="mt-1 text-sm text-negative">{String(row.error ?? 'Rejected without an error message')}</p></div></div>)}
          </Panel>
        </div>
      </div>
    </>
  )
}
