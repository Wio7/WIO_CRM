'use client';

// ============================================================
// One answered call, expandable to its transcript.
//
// Shared by the global tray (/calls) and the contact detail sheet, so
// the recommendation vocabulary and status wording can't drift between
// the two surfaces.
// ============================================================

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  PhoneIncoming,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';

export interface CallResultRow {
  id: string;
  contact_id: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  advisor_name?: string | null;
  mode: string;
  recording_url: string | null;
  transcript: string | null;
  ai_summary: string | null;
  ai_recommendation: string | null;
  transcription_status: string;
  transcription_error: string | null;
  duration_sec: number | null;
  created_at: string;
}

const RECOMMENDATION_META: Record<string, { label: string; className: string }> = {
  alta_intencion: {
    label: 'Alta intención',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  },
  pedir_info: {
    label: 'Pidió información',
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  reagendar: {
    label: 'Reagendar',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  },
  no_interesado: {
    label: 'No interesado',
    className: 'border-red-500/40 bg-red-500/10 text-red-400',
  },
  no_calificado: {
    label: 'No calificado',
    className: 'border-border bg-muted text-muted-foreground',
  },
};

export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CallResultCard({
  call,
  showContact = true,
}: {
  call: CallResultRow;
  showContact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rec = call.ai_recommendation
    ? RECOMMENDATION_META[call.ai_recommendation]
    : null;

  const hasDetail = !!call.transcript || !!call.ai_summary;

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex w-full items-start gap-3 p-4 text-left ${
          hasDetail ? 'cursor-pointer hover:bg-muted/40' : 'cursor-default'
        }`}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15">
          <PhoneIncoming className="size-4 text-primary" aria-hidden />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {showContact && (
              <span className="truncate text-sm font-medium text-foreground">
                {call.contact_name || call.contact_phone || 'Contacto eliminado'}
              </span>
            )}
            {rec && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${rec.className}`}
              >
                {rec.label}
              </span>
            )}
            {call.mode === 'ia' && (
              <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-400">
                IA
              </span>
            )}
          </div>

          {call.ai_summary ? (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {call.ai_summary}
            </p>
          ) : call.transcription_status === 'pendiente' ||
            call.transcription_status === 'procesando' ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Transcribiendo…
            </p>
          ) : call.transcription_status === 'omitido' ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Sin transcripción — {call.transcription_error ?? 'no configurada'}
            </p>
          ) : call.transcription_status === 'fallo' ? (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              {call.transcription_error ?? 'No se pudo transcribir'}
            </p>
          ) : null}

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{formatDuration(call.duration_sec)}</span>
            <span aria-hidden>·</span>
            <span>
              {formatDistanceToNow(new Date(call.created_at), {
                addSuffix: true,
                locale: es,
              })}
            </span>
            {call.advisor_name && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{call.advisor_name}</span>
              </>
            )}
          </div>
        </div>

        {hasDetail && (
          <span className="mt-1 shrink-0 text-muted-foreground">
            {open ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3">
          {call.ai_summary && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Sparkles className="size-3 text-primary" />
                Resumen
              </p>
              <p className="text-sm text-muted-foreground">{call.ai_summary}</p>
            </div>
          )}
          {call.transcript && (
            <div>
              <p className="mb-1 text-xs font-medium text-foreground">Transcripción</p>
              <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                {call.transcript}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
