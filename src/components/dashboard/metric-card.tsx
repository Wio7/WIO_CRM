import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { TONES, type Tone } from '@/lib/tones'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
  /** Color del ícono y del fondo en el celular. */
  tone?: Tone
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle, tone }: MetricCardProps) {
  return (
    <div className={cn('min-w-0 rounded-2xl border border-border bg-card p-4 lg:rounded-xl lg:p-5', tone && TONES[tone].card)}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <p className="order-2 text-[13px] leading-tight font-medium text-muted-foreground lg:order-none lg:text-sm">{title}</p>
        <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl lg:size-8 lg:rounded-lg', tone ? TONES[tone].icon : 'bg-muted text-muted-foreground')}>
          <Icon className="size-5 lg:size-4" />
        </div>
      </div>
      <p className="mt-2 text-2xl leading-none break-words lg:mt-3 lg:text-[28px] font-bold tabular-nums text-foreground">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-primary'
      : sign < 0
      ? 'text-red-400'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-2 flex items-center gap-1 text-xs lg:text-sm', tone)}>
      <Arrow className="h-4 w-4" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
