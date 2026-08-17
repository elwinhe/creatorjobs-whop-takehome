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
      <header className="bg-rail text-white shadow-rail">
        <div className="mx-auto flex max-w-[90rem] flex-col gap-4 px-4 py-4 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10">
          <a className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-semibold tracking-[-0.03em]" href="/">
            <span className="grid size-10 place-items-center rounded-md bg-primary text-white">
              <BriefcaseBusiness aria-hidden="true" className="size-4.5" />
            </span>
            <span>CreatorJobs</span>
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-rail-muted">Sandbox ops</span>
          </a>
          <nav aria-label="Primary" className="grid w-full grid-cols-3 gap-1 lg:flex lg:w-auto">
            {navigation.map(({ href, icon: Icon, label }) => {
              const active = href === '/' ? path === '/' : path.startsWith(href)
              return (
                <a
                  className={cn(
                    'inline-flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-md px-1 text-[0.6875rem] font-medium leading-tight transition-[background-color,color] duration-[var(--creatorjobs-motion-fast)] ease-[var(--creatorjobs-motion-ease)] sm:gap-2 sm:px-3 sm:text-sm',
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
      <div className="mx-auto max-w-[90rem] px-4 py-8 sm:px-8 lg:px-10 lg:py-12">{children}</div>
    </main>
  )
}
