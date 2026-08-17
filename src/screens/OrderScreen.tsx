import { CheckCircle2, LoaderCircle, RotateCcw, Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Surface } from '../components/ui/Surface'
import { api, money, shortId } from '../lib/api'
import { statusTone } from '../lib/status'

type Order = { amount_cents: number; buyer_email: string; currency: string; events: Array<{ applied: boolean; created_at: string; from_status: string; to_status: string }>; id: string; listing_title: string; seller_name: string; status: string }

export function OrderScreen({ id }: { id: string }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [note, setNote] = useState('Final deliverable: https://example.com/delivery')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api<Order>(`/api/orders/${id}`).then(setOrder).catch((reason: Error) => setError(reason.message)), [id])
  useEffect(() => { void load(); const timer = window.setInterval(load, 4_000); return () => window.clearInterval(timer) }, [load])

  async function action(name: 'accept' | 'submit' | 'approve' | 'reject') {
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await api<{ transferred?: boolean }>(`/api/orders/${id}/${name}`, { body: name === 'submit' ? JSON.stringify({ note }) : undefined, method: 'POST' })
      if (name === 'approve') setNotice(result.transferred ? 'Approved. The seller has been paid out.' : 'Approved. The seller payout is settling with Whop and will complete automatically.')
      await load()
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Action failed') }
    finally { setBusy(false) }
  }

  if (!order) return <div aria-live="polite" className="grid min-h-64 place-items-center text-center text-sm text-negative">{error ?? <LoaderCircle aria-label="Loading order" className="size-6 animate-spin text-primary" />}</div>
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section>
        <Badge tone={statusTone(order.status)}>{order.status.replaceAll('_', ' ')}</Badge>
        <h1 className="mt-5 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">{order.listing_title}</h1>
        <p className="mt-4 break-words text-lg text-muted-foreground">{order.seller_name} for <span className="[overflow-wrap:anywhere]">{order.buyer_email}</span></p>
        <dl className="mt-8 grid gap-4 border-y border-border py-6 sm:grid-cols-3">
          <div><dt className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">Order</dt><dd className="mt-2 font-mono text-sm" title={order.id}>{shortId(order.id)}</dd></div>
          <div><dt className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">Amount</dt><dd className="mt-2 text-xl font-semibold" data-numeric>{money(order.amount_cents, order.currency)}</dd></div>
          <div><dt className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">Refresh</dt><dd className="mt-2 flex items-center gap-2 text-sm"><RotateCcw className="size-3.5 text-primary" /> Every 4 seconds</dd></div>
        </dl>
        {error && <p className="mt-5 rounded-md bg-negative-subtle px-4 py-3 text-sm font-medium text-negative shadow-error" role="alert">{error}</p>}
        {notice && !error && <p className="mt-5 rounded-md border border-border bg-muted px-4 py-3 text-sm font-medium text-muted-foreground" role="status">{notice}</p>}
        <div className="mt-7 flex flex-wrap items-center gap-3">
          {order.status === 'paid' && <Button disabled={busy} onClick={() => action('accept')}>Accept order</Button>}
          {order.status === 'in_progress' && <><Input className="min-w-0 flex-1 basis-52" onChange={(event) => setNote(event.target.value)} value={note} /><Button className="max-sm:w-full" disabled={busy} onClick={() => action('submit')}><Send className="size-4" /> Submit work</Button></>}
          {order.status === 'delivered' && <><Button disabled={busy} onClick={() => action('approve')}><CheckCircle2 className="size-4" /> Approve & pay</Button><Button disabled={busy} onClick={() => action('reject')} variant="secondary">Request rework</Button></>}
        </div>
      </section>
      <Surface className="h-fit p-5">
        <h2 className="font-semibold">Transition ledger</h2>
        <ol className="mt-4 space-y-4">
          {order.events.length === 0 && <li className="text-sm text-muted-foreground">Waiting for the first transition.</li>}
          {order.events.map((event, index) => <li className="grid grid-cols-[auto_1fr] gap-3 text-sm" key={`${event.created_at}-${index}`}><span className={`mt-1 size-2 rounded-full ${event.applied ? 'bg-positive' : 'bg-negative'}`} /><div><p className="font-medium">{event.from_status} → {event.to_status}</p><p className="mt-1 font-mono text-[0.625rem] text-muted-foreground">{event.applied ? 'APPLIED' : 'REJECTED'} · {new Date(event.created_at).toLocaleString()}</p></div></li>)}
        </ol>
      </Surface>
    </div>
  )
}
