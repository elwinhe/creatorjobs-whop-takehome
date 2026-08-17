import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-md bg-surface px-3.5 text-sm shadow-control transition-[box-shadow] duration-[var(--creatorjobs-motion-fast)] ease-[var(--creatorjobs-motion-ease)] placeholder:text-muted-foreground/70 hover:shadow-control-hover focus:shadow-control-focus focus:outline-none disabled:cursor-not-allowed disabled:bg-background disabled:text-muted-foreground disabled:shadow-none',
        className,
      )}
      {...props}
    />
  )
}
