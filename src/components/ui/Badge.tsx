import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

const toneClasses = {
  accent: 'bg-primary-subtle text-primary-hover',
  danger: 'bg-negative-subtle text-negative',
  neutral: 'bg-foreground/5 text-muted-foreground',
  success: 'bg-positive-subtle text-positive',
} as const

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: keyof typeof toneClasses
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-center font-mono text-[0.625rem] font-medium uppercase leading-4 tracking-[0.12em] shadow-status',
        toneClasses[tone],
        className,
      )}
      {...props}
    />
  )
}
