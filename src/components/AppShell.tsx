import { BriefcaseBusiness, LayoutDashboard, Store, UserRoundPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

const navigation = [
  { href: '/', icon: Store, label: 'Marketplace' },
  { href: '/seller', icon: UserRoundPlus, label: 'Seller setup' },
  { href: '/dashboard', icon: LayoutDashboard, label: 'Operations' },
]

export function AppShell({ children }: { children: ReactNode }) {
  const path = window.location.pathname
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div aria-hidden="true" className="h-1 bg-primary" />
      <header className="bg-rail text-white shadow-[0_1px_0_rgb(255_255_255/8%)]">
        <div className="mx-auto flex max-w-[90rem] flex-col gap-4 px-5 py-4 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10">
          <a className="flex min-h-10 items-center gap-3 font-semibold tracking-[-0.03em]" href="/">
            <span className="grid size-10 place-items-center rounded-md bg-primary text-white">
              <BriefcaseBusiness aria-hidden="true" className="size-4.5" />
            </span>
            <span>CreatorJobs</span>
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-rail-muted">Sandbox ops</span>
          </a>
          <nav aria-label="Primary" className="flex gap-1 overflow-x-auto">
            {navigation.map(({ href, icon: Icon, label }) => {
              const active = href === '/' ? path === '/' : path.startsWith(href)
              return (
                <a
                  className={cn(
                    'inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-[background-color,color] duration-[var(--creatorjobs-motion-fast)]',
                    active ? 'bg-white text-rail' : 'text-rail-muted hover:bg-white/8 hover:text-white',
                  )}
                  href={href}
                  key={href}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {label}
                </a>
              )
            })}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-[90rem] px-5 py-8 sm:px-8 lg:px-10 lg:py-12">{children}</div>
    </main>
  )
}
