'use client';

// Simple template screen: write the message, send it to WhatsApp for
// approval, see in plain words whether it can be used. The full editor
// (variables, buttons, media) stays in Configuración → Plantillas.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, RefreshCw, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  OPT_OUT_FOOTER,
  templateNameFromTitle,
  templateStatusText,
} from '@/lib/whatsapp/simple-template';
import type { MessageTemplate } from '@/types';

const TONE_CLASSES = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  wait: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
  bad: 'border-red-500/30 bg-red-500/10 text-red-400',
} as const;

const BODY_MAX = 1024;

export default function SimpleTemplatesPage() {
  const { accountId } = useAuth();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [footer, setFooter] = useState(OPT_OUT_FOOTER);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await createClient()
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    if (error) toast.error(`No se pudieron cargar las plantillas: ${error.message}`);
    setTemplates(((data ?? []) as MessageTemplate[]).filter((t) => t.name !== 'hello_world'));
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncStatuses() {
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
      await load();
      toast.success('Estados actualizados');
    } catch (err) {
      toast.error(`No se pudo actualizar: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setSyncing(false);
    }
  }

  const name = templateNameFromTitle(title);
  const nameTaken = templates.some((t) => t.name === name);
  const canSubmit = name.length > 0 && !nameTaken && body.trim().length > 0 && !submitting;

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch('/api/whatsapp/templates/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          category: 'Marketing',
          language: 'es',
          body_text: body.trim(),
          footer_text: footer.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
      toast.success('Plantilla enviada a WhatsApp para su aprobación');
      setTitle('');
      setBody('');
      setFooter(OPT_OUT_FOOTER);
      await load();
    } catch (err) {
      toast.error(`WhatsApp no la recibió: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/broadcasts"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
            aria-label="Volver a campañas"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Mis plantillas</h1>
            <p className="text-sm text-muted-foreground">
              WhatsApp solo deja escribir primero con un mensaje aprobado. Créalo aquí.
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={syncStatuses} disabled={syncing}>
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          Actualizar estados
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
          <p className="text-base font-semibold text-foreground">Nueva plantilla</p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Nombre (solo para ti)</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej. Recordatorio noviembre"
            />
            {name && (
              <p className={`text-xs ${nameTaken ? 'text-red-400' : 'text-muted-foreground'}`}>
                {nameTaken ? 'Ya tienes una plantilla con ese nombre.' : `Se guarda como: ${name}`}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Mensaje</label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
              rows={7}
              placeholder="Hola, te escribe Julio de Broker Home. Hace un tiempo nos consultaste por propiedades…"
            />
            <p className="text-xs text-muted-foreground">
              {body.length}/{BODY_MAX}. Di quién escribe y por qué; así menos personas te bloquean.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Línea final</label>
            <Input value={footer} onChange={(e) => setFooter(e.target.value.slice(0, 60))} />
            <p className="text-xs text-muted-foreground">
              Quien responda BAJA deja de recibir tus campañas automáticamente.
            </p>
          </div>
          <Button onClick={submit} disabled={!canSubmit} className="w-full">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Enviar a aprobar
          </Button>
          <p className="text-xs text-muted-foreground">
            Se crea como mensaje de marketing en español. WhatsApp cobra cada mensaje entregado.
          </p>
        </div>

        <div className="space-y-2 rounded-2xl border border-border bg-[#0b141a] p-5">
          <p className="text-sm font-medium text-muted-foreground">Así lo verán en WhatsApp</p>
          <div className="max-w-[90%] rounded-xl rounded-tl-none bg-[#202c33] p-3 text-sm text-[#e9edef] shadow">
            <p className="whitespace-pre-wrap">{body.trim() || 'Tu mensaje aparecerá aquí.'}</p>
            {footer.trim() && <p className="mt-2 text-xs text-[#8696a0]">{footer.trim()}</p>}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-base font-semibold text-foreground">Tus plantillas</p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no tienes plantillas.</p>
        ) : (
          <ul className="space-y-2">
            {templates.map((t) => {
              const s = templateStatusText(t.status);
              return (
                <li key={t.id} className="rounded-2xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-foreground">{t.name}</p>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[s.tone]}`}>
                      {s.label}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {t.body_text}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {s.hint}
                    {t.status === 'REJECTED' && t.rejection_reason ? ` Motivo: ${t.rejection_reason}.` : ''}
                  </p>
                  {t.status === 'APPROVED' && (
                    <Link href="/broadcasts/new" className="mt-2 inline-block text-sm text-primary hover:underline">
                      Usarla en una campaña
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
