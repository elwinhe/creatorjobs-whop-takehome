import {
  ArrowUpRight,
  BriefcaseBusiness,
  CircleDollarSign,
  Radio,
  ShieldCheck,
  UsersRound,
} from 'lucide-react'
import { Badge } from './components/ui/Badge'
import { Button } from './components/ui/Button'
import { Surface } from './components/ui/Surface'

const rails = [
  {
    icon: UsersRound,
    label: 'Seller rail',
    title: 'Onboarding and payout readiness',
    detail: 'Connected account, identity checks, and payout method status.',
  },
  {
    icon: CircleDollarSign,
    label: 'Buyer rail',
    title: 'Checkout and payment confirmation',
    detail: 'A traceable path from listing checkout to confirmed payment.',
  },
  {
    icon: Radio,
    label: 'Operations rail',
    title: 'Order and webhook reconciliation',
    detail: 'One timeline for marketplace state, deliveries, retries, and errors.',
  },
]

function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div aria-hidden="true" className="h-1 w-full bg-primary" />

      <div className="mx-auto flex min-h-[calc(100vh-4px)] max-w-7xl flex-col px-5 sm:px-8 lg:px-12">
        <header className="flex items-center justify-between border-b border-border py-5">
          <a className="flex items-center gap-3 font-semibold tracking-[-0.02em]" href="/">
            <span className="grid size-9 place-items-center rounded-lg bg-foreground text-background">
              <BriefcaseBusiness aria-hidden="true" className="size-4.5" />
            </span>
            CreatorJobs
          </a>

          <Badge tone="accent">Foundation / v0.1</Badge>
        </header>

        <section className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1.15fr_0.85fr] lg:py-24">
          <div className="max-w-3xl">
            <p className="mb-5 font-mono text-xs font-medium uppercase tracking-[0.16em] text-primary">
              Marketplace operations, powered by Whop
            </p>
            <h1 className="max-w-2xl text-balance text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-6xl lg:text-7xl">
              Every job, dollar, and handoff in one clear system.
            </h1>
            <p className="mt-7 max-w-xl text-pretty text-lg leading-8 text-muted-foreground">
              A minimal marketplace foundation for businesses hiring creators—with seller
              onboarding, checkout, fulfillment, and payout status designed to reconcile cleanly.
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <Button asChild>
                <a href="https://docs.whop.com" rel="noreferrer" target="_blank">
                  Open Whop docs
                  <ArrowUpRight aria-hidden="true" className="size-4" />
                </a>
              </Button>
              <Button asChild variant="secondary">
                <a href="https://github.com/elwinhe/creatorjobs-whop-takehome">
                  View repository
                </a>
              </Button>
            </div>
          </div>

          <Surface className="relative overflow-hidden p-2">
            <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-primary" />
            <div className="border-b border-border px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">
                    System map
                  </p>
                  <p className="mt-1 font-semibold tracking-[-0.02em]">V1 operating rails</p>
                </div>
                <ShieldCheck aria-label="Security planned" className="size-5 text-primary" />
              </div>
            </div>

            <div className="divide-y divide-border">
              {rails.map(({ detail, icon: Icon, label, title }) => (
                <article className="group grid grid-cols-[auto_1fr] gap-4 px-5 py-5" key={label}>
                  <span className="grid size-10 place-items-center rounded-lg bg-primary-subtle text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <Icon aria-hidden="true" className="size-4.5" />
                  </span>
                  <div>
                    <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                      {label}
                    </p>
                    <h2 className="mt-1 font-semibold leading-6 tracking-[-0.02em]">{title}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</p>
                  </div>
                </article>
              ))}
            </div>
          </Surface>
        </section>

        <footer className="flex flex-col gap-2 border-t border-border py-5 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>React · TypeScript · Tailwind · Hono · Bun</span>
          <span>Schema intentionally pending</span>
        </footer>
      </div>
    </main>
  )
}

export default App
