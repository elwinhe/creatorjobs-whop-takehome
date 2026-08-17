import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-md bg-surface px-3.5 text-sm shadow-[inset_0_0_0_1px_var(--color-border)] transition-[box-shadow] duration-[var(--creatorjobs-motion-fast)] placeholder:text-muted-foreground/70 focus:shadow-[inset_0_0_0_2px_var(--color-primary)] focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}
