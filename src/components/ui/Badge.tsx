import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

const toneClasses = {
  accent: 'bg-primary-subtle text-primary-hover',
  neutral: 'bg-foreground/5 text-muted-foreground',
} as const

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: keyof typeof toneClasses
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em]',
        toneClasses[tone],
        className,
      )}
      {...props}
    />
  )
}
