import {
  cloneElement,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import { cn } from '../../lib/cn'

const variantClasses = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary: 'border border-border bg-surface text-foreground hover:border-foreground/35',
  ghost: 'text-foreground hover:bg-foreground/5',
} as const

const sizeClasses = {
  sm: 'h-10 px-3 text-sm',
  md: 'h-11 px-4 text-sm',
} as const

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  children: ReactElement | ReactNode
  size?: keyof typeof sizeClasses
  variant?: keyof typeof variantClasses
}

export function Button({
  asChild = false,
  children,
  className,
  size = 'md',
  variant = 'primary',
  ...props
}: ButtonProps) {
  const classes = cn(
    'inline-flex min-h-10 items-center justify-center gap-2 rounded-md font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,scale] duration-[var(--creatorjobs-motion-fast)] ease-[var(--creatorjobs-motion-ease)] active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50',
    variantClasses[variant],
    sizeClasses[size],
    className,
  )

  if (asChild && isValidElement<{ className?: string }>(children)) {
    return cloneElement(children, {
      className: cn(classes, children.props.className),
    })
  }

  return (
    <button className={classes} {...props}>
      {children}
    </button>
  )
}
