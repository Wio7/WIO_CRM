"use client";

// Diálogo de gestión de cobranza: historial del cliente y formulario para
// registrar una nueva (llamada, WhatsApp, visita...). Tabla
// collection_actions (migración 082).

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  CHANNELS,
  RESULTS,
  channelLabel,
  resultLabel,
  validateAction,
  type ActionChannel,
  type ActionResult,
  type CollectionAction,
} from "@/lib/collection-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  contactName: string;
  today: string;
  onSaved: (action: CollectionAction) => void;
}

const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const fecha = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

const selectClass = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

export function CollectionActionDialog({ open, onOpenChange, contactId, contactName, today, onSaved }: Props) {
  const { accountId } = useAuth();
  const [history, setHistory] = useState<CollectionAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [channel, setChannel] = useState<ActionChannel>("llamada");
  const [result, setResult] = useState<ActionResult>("contactado");
  const [promiseDate, setPromiseDate] = useState("");
  const [promiseAmount, setPromiseAmount] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    // El diálogo se monta de nuevo para cada cliente (key en la página),
    // así el formulario arranca vacío sin resetearlo aquí.
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("collection_actions")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(30);
      const rows = (data ?? []) as CollectionAction[];
      // created_by es el usuario de auth: el nombre sale de profiles.user_id.
      const ids = [...new Set(rows.map((r) => r.created_by).filter((x): x is string => Boolean(x)))];
      if (ids.length) {
        const { data: people } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
        const names = new Map(
          ((people ?? []) as { user_id: string; full_name: string | null }[]).map((p) => [p.user_id, p.full_name]),
        );
        for (const r of rows) r.author = { full_name: r.created_by ? names.get(r.created_by) ?? null : null };
      }
      if (!cancelled) {
        setHistory(rows);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId]);

  async function save() {
    const err = validateAction({ channel, result, promiseDate, promiseAmount, note }, today);
    if (err) {
      toast.error(err);
      return;
    }
    if (!accountId) return;
    setSaving(true);
    const { data, error } = await createClient()
      .from("collection_actions")
      .insert({
        account_id: accountId,
        contact_id: contactId,
        channel,
        result,
        promise_date: result === "promesa" ? promiseDate : null,
        promise_amount: promiseAmount ? Number(promiseAmount) : null,
        note: note.trim() || null,
      })
      .select("*")
      .single();
    setSaving(false);
    if (error) {
      toast.error(`No se pudo guardar: ${error.message}`);
      return;
    }
    toast.success("Gestión registrada");
    onSaved(data as CollectionAction);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Gestión de cobranza</DialogTitle>
          <DialogDescription>{contactName}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            Canal
            <select className={selectClass} value={channel} onChange={(e) => setChannel(e.target.value as ActionChannel)}>
              {CHANNELS.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Resultado
            <select className={selectClass} value={result} onChange={(e) => setResult(e.target.value as ActionResult)}>
              {RESULTS.map((r) => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </select>
          </label>
          {result === "promesa" && (
            <>
              <label className="space-y-1 text-xs text-muted-foreground">
                Pagará el
                <Input type="date" min={today} value={promiseDate} onChange={(e) => setPromiseDate(e.target.value)} />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Monto (opcional)
                <Input type="number" inputMode="decimal" min="0" step="0.01" value={promiseAmount} onChange={(e) => setPromiseAmount(e.target.value)} />
              </label>
            </>
          )}
          <label className="col-span-2 space-y-1 text-xs text-muted-foreground">
            Nota
            <Textarea rows={2} maxLength={1000} placeholder="Qué dijo el cliente" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Historial</p>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay gestiones con este cliente.</p>
          ) : (
            <ul className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
              {history.map((h) => (
                <li key={h.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-medium">
                      {channelLabel(h.channel)} · {resultLabel(h.result)}
                      {h.promise_date && <span className="text-primary"> · {fecha(h.promise_date)}</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">{fechaHora(h.created_at)}</span>
                  </div>
                  {h.note && <p className="mt-0.5 text-xs text-muted-foreground">{h.note}</p>}
                  {h.author?.full_name && <p className="text-[11px] text-muted-foreground/70">{h.author.full_name}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Guardar gestión
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
