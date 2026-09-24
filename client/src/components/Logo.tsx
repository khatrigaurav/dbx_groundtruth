import { cn } from '../lib/utils'

// Brand lockup: the Databricks Genie app icon (public/genie-icon.svg — same mark as the
// browser tab) plus the "GroundTruth" wordmark (Navy, inherits the current text color).
export function Logo({
  className,
  markClass = 'h-7 w-7',
  wordClass,
  word = true,
}: {
  className?: string
  markClass?: string
  wordClass?: string
  word?: boolean
}) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <img src="/genie-icon.svg" alt="" aria-hidden className={cn('shrink-0', markClass)} />
      {word && (
        <span className={cn('font-semibold tracking-tight', wordClass)}>GroundTruth</span>
      )}
    </span>
  )
}
