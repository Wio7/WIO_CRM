"use client";

// Botón + diálogo para pasar un caso a otra área (migración 085).
// Si la 085 no está aplicada no se muestra nada; si el área de destino no
// tiene a nadie, el botón queda desactivado con un aviso.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { HANDOFF_KINDS, TOPIC_LABELS, type HandoffKind, type HandoffTopic } from "@/lib/handoffs/kinds";
import { destinationReady, sendHandoff } from "@/lib/handoffs/rpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const AREA: Record<string, string> = { cobranzas: "Cobranzas", legal: "Legal", postventa: "Postventa" };
const selectClass = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

type Ready = "cargando" | "si" | "no" | "sin085";

// Una consulta por tipo de traspaso, no una por fila de la lista.
const cache = new Map<HandoffKind, Promise<Ready>>();
function consultar(kind: HandoffKind): Promise<Ready> {
  let p = cache.get(kind);
  if (!p) {
    p = destinationReady(createClient(), kind)
      .then((r): Ready => (r.ok ? (r.data ? "si" : "no") : r.missing085 ? "sin085" : "si"))
      .catch((): Ready => "si");
    cache.set(kind, p);
    // Para que el aviso se actualice si alguien se incorpora al área.
    setTimeout(() => cache.delete(kind), 60_000);
  }
  return p;
}

interface Props {
  kind: HandoffKind;
  entityId: string;
  onSent?: () => void;
}

export function SendHandoffButton({ kind, entityId, onSent }: Props) {
  const def = HANDOFF_KINDS[kind];
  const [ready, setReady] = useState<Ready>("cargando");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [topic, setTopic] = useState<HandoffTopic | "">("");
  const [busy, setBusy] = useState(false);
  const pideTema = def.to === "postventa";

  useEffect(() => {
    let vivo = true;
    consultar(kind).then((r) => {
      if (vivo) setReady(r);
    });
    return () => {
      vivo = false;
    };
  }, [kind]);

  if (ready === "sin085") return null;

  async function enviar() {
    if (pideTema && !topic) {
      toast.error("Elige el tema del caso");
      return;
    }
    setBusy(true);
    const r = await sendHandoff(createClient(), {
      kind,
      entityId,
      note: note.trim() || null,
      topic: topic || null,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success(`Enviado a ${AREA[def.to]}`);
    setOpen(false);
    setNote("");
    setTopic("");
    onSent?.();
  }

  const sinNadie = ready === "no";
  const aviso = `Todavía no hay nadie en ${AREA[def.to]}`;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={sinNadie}
        title={sinNadie ? aviso : undefined}
        onClick={() => setOpen(true)}
      >
        <Send className="h-3.5 w-3.5" /> {def.button}
      </Button>
      {sinNadie && <span className="sr-only">{aviso}</span>}
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{def.button}</DialogTitle>
            <DialogDescription>
              Lo recibe {AREA[def.to]} y lo verá en su bandeja. Deja una nota para que no tenga que preguntarte.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {pideTema && (
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Tema</span>
                <select
                  className={selectClass}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value as HandoffTopic | "")}
                >
                  <option value="">Elige un tema</option>
                  {(Object.keys(TOPIC_LABELS) as HandoffTopic[]).map((t) => (
                    <option key={t} value={t}>
                      {TOPIC_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Nota (opcional)</span>
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={enviar} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
