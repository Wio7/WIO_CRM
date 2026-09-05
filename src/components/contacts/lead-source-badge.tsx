// ============================================================
// Lead-source vocabulary — the one place origin labels and colours
// are defined, so the contacts table, the filter dropdown, and the
// detail panel can't drift apart.
//
// `lead_source` is free-form TEXT in the DB (migration 035), written by
// three producers: the Meta Lead Ads webhooks ('meta_ads'), the WhatsApp
// webhook ('whatsapp' / 'whatsapp_ad'), and POST /api/v1/leads (whatever
// the caller sends, typically 'web'). Anything unrecognised renders as
// itself rather than being hidden — a source we didn't anticipate is
// still information.
// ============================================================

export interface LeadSourceMeta {
  label: string;
  className: string;
}

export const LEAD_SOURCE_META: Record<string, LeadSourceMeta> = {
  meta_ads: {
    label: 'Meta Ads',
    className: 'border-[#1877F2]/40 bg-[#1877F2]/10 text-[#4693ff]',
  },
  whatsapp_ad: {
    label: 'Anuncio WhatsApp',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  },
  whatsapp: {
    label: 'WhatsApp',
    className: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-500/80',
  },
  web: {
    label: 'Web',
    className: 'border-violet-500/40 bg-violet-500/10 text-violet-400',
  },
  referral: {
    label: 'Referido',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  },
  manual: {
    label: 'Manual',
    className: 'border-border bg-muted text-muted-foreground',
  },
};

/** Options for the filter dropdown, in the order they should appear. */
export const LEAD_SOURCE_OPTIONS = [
  'meta_ads',
  'whatsapp_ad',
  'whatsapp',
  'web',
  'referral',
  'manual',
] as const;

export function leadSourceLabel(source: string): string {
  return LEAD_SOURCE_META[source]?.label ?? source;
}

export function LeadSourceBadge({ source }: { source?: string | null }) {
  if (!source) return <span className="text-muted-foreground text-xs">-</span>;
  const meta = LEAD_SOURCE_META[source];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap ${
        meta?.className ?? 'border-border bg-muted text-muted-foreground'
      }`}
    >
      {meta?.label ?? source}
    </span>
  );
}
