'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { CallResultCard, type CallResultRow } from '@/components/calls/call-result-card';
import { Loader2, PhoneCall } from 'lucide-react';

const LIMIT = 100;

interface RawRow {
  id: string;
  contact_id: string | null;
  mode: string;
  recording_url: string | null;
  transcript: string | null;
  ai_summary: string | null;
  ai_recommendation: string | null;
  transcription_status: string;
  transcription_error: string | null;
  duration_sec: number | null;
  created_at: string;
  contact: { name: string | null; phone: string | null } | null;
  advisor: { full_name: string | null } | null;
}

export default function CallsPage() {
  const supabase = createClient();
  const { accountId } = useAuth();
  const [calls, setCalls] = useState<CallResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const { data, error: err } = await supabase
      .from('call_results')
      .select(
        'id, contact_id, mode, recording_url, transcript, ai_summary, ai_recommendation, transcription_status, transcription_error, duration_sec, created_at, contact:contacts(name, phone), advisor:profiles(full_name)',
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(LIMIT);

    if (err) {
      setError('No se pudieron cargar las llamadas.');
      return;
    }
    setError(null);
    setCalls(
      ((data ?? []) as unknown as RawRow[]).map((r) => ({
        id: r.id,
        contact_id: r.contact_id,
        contact_name: r.contact?.name ?? null,
        contact_phone: r.contact?.phone ?? null,
        advisor_name: r.advisor?.full_name ?? null,
        mode: r.mode,
        recording_url: r.recording_url,
        transcript: r.transcript,
        ai_summary: r.ai_summary,
        ai_recommendation: r.ai_recommendation,
        transcription_status: r.transcription_status,
        transcription_error: r.transcription_error,
        duration_sec: r.duration_sec,
        created_at: r.created_at,
      })),
    );
  }, [supabase, accountId]);

  useEffect(() => {
    // Initial fetch — same shape as the notifications tray.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Transcription lands minutes after the call, written by the cron —
  // realtime is what turns "Transcribiendo…" into the summary without
  // the advisor refreshing.
  useEffect(() => {
    if (!accountId) return;
    const channel = supabase
      .channel('calls-page')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'call_results' },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, accountId, load]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Llamadas</h1>
        <p className="text-sm text-muted-foreground">
          Llamadas contestadas, con su resumen y recomendación generados por IA.
        </p>
      </div>

      {calls === null ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : calls.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
            <PhoneCall className="size-5 text-primary" />
          </div>
          <p className="font-medium text-foreground">Aún no hay llamadas</p>
          <p className="text-sm text-muted-foreground">
            Las llamadas contestadas desde el Marcador aparecerán aquí.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {calls.map((call) => (
            <li key={call.id}>
              <CallResultCard call={call} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
