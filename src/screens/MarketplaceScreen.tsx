import { ArrowRight, Film, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Surface } from '../components/ui/Surface'
import { api, money } from '../lib/api'

type Listing = {
  currency: string
  description: string
  id: string
  price_cents: number
  seller_name: string
  title: string
}

export function MarketplaceScreen() {
  const [buyerEmail, setBuyerEmail] = useState('buyer.one@creatorjobs.test')
  const [error, setError] = useState<string | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [purchasing, setPurchasing] = useState<string | null>(null)

  useEffect(() => {
    api<{ listings: Listing[] }>('/api/listings')
      .then((result) => setListings(result.listings))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false))
  }, [])

  async function purchase(listingId: string) {
    setError(null)
    setPurchasing(listingId)
    try {
      const result = await api<{ order_id: string; purchase_url: string }>('/api/orders', {
        body: JSON.stringify({ buyer_email: buyerEmail, listing_id: listingId }),
        method: 'POST',
      })
      window.location.assign(result.purchase_url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Checkout failed')
      setPurchasing(null)
    }
  }

  return (
    <>
      <section className="grid gap-8 border-b border-border pb-10 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <Badge tone="accent">Open creator services</Badge>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.02] tracking-[-0.05em] sm:text-5xl lg:text-6xl">
            Hire the work. Track every handoff.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
            Checkout is handled by Whop; delivery, approval, payout, and every retry remain visible in CreatorJobs.
          </p>
        </div>
        <label className="block w-full lg:w-80">
          <span className="mb-2 block font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">Buyer email</span>
          <Input onChange={(event) => setBuyerEmail(event.target.value)} type="email" value={buyerEmail} />
        </label>
      </section>

      {error && <p className="mt-6 rounded-md bg-negative-subtle px-4 py-3 text-sm text-negative" role="alert">{error}</p>}
      {loading ? (
        <div className="grid min-h-64 place-items-center text-muted-foreground"><LoaderCircle className="size-6 animate-spin" /></div>
      ) : (
        <section aria-label="Listings" className="grid gap-5 py-8 md:grid-cols-2 xl:grid-cols-3">
          {listings.map((listing, index) => (
            <Surface className="group flex min-h-80 flex-col overflow-hidden p-2" key={listing.id}>
              <div className="flex flex-1 flex-col rounded-md bg-background p-5">
                <div className="flex items-start justify-between gap-4">
                  <span className="grid size-11 place-items-center rounded-md bg-primary-subtle text-primary-hover"><Film className="size-4.5" /></span>
                  <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                </div>
                <p className="mt-8 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-primary-hover">{listing.seller_name}</p>
                <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em]">{listing.title}</h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{listing.description}</p>
                <div className="mt-auto flex items-end justify-between gap-4 pt-8">
                  <div>
                    <p className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">Project fee</p>
                    <p className="mt-1 text-2xl font-semibold tracking-[-0.03em]" data-numeric>{money(listing.price_cents, listing.currency)}</p>
                  </div>
                  <Button aria-label={`Buy ${listing.title}`} disabled={purchasing !== null || !buyerEmail} onClick={() => purchase(listing.id)}>
                    {purchasing === listing.id ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                    Buy
                  </Button>
                </div>
              </div>
            </Surface>
          ))}
        </section>
      )}
    </>
  )
}
