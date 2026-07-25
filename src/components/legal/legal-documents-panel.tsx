"use client";

import { useState, useEffect, useCallback } from "react";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import type { LegalDocument, LegalDocStatus, LegalDocType } from "@/types";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { Anexo01Form } from "@/components/legal/anexo-01-form";
import { Anexo02Form } from "@/components/legal/anexo-02-form";
import { Check, Download, FileText, Loader2, Pencil, X } from "lucide-react";
import { toast } from "sonner";

const STATUS_LABEL: Record<LegalDocStatus, string> = {
  borrador: "Borrador",
  pendiente: "Pendiente",
  aprobado: "Aprobado",
  rechazado: "Rechazado",
  listo_para_firma: "Listo para Firma",
};

const STATUS_BADGE: Record<LegalDocStatus, string> = {
  borrador: "border-border bg-muted text-muted-foreground",
  pendiente: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  aprobado: "border-primary/40 bg-primary/10 text-primary",
  rechazado: "border-red-500/40 bg-red-500/10 text-red-400",
  listo_para_firma: "border-green-500/40 bg-green-500/10 text-green-400",
};

const DOC_LABELS: Record<LegalDocType, string> = {
  anexo_01: "Anexo 01 — Datos del Comprador",
  anexo_02: "Anexo 02 — Financiamiento y Cuotas",
  minuta: "Minuta — Contrato de Compraventa",
};

interface LegalDocumentsPanelProps {
  reservationId: string;
  reservationTotal: number;
  currency: string;
  contactName: string;
}

export function LegalDocumentsPanel({
  reservationId,
  reservationTotal,
  currency,
  contactName,
}: LegalDocumentsPanelProps) {
  const canApprove = useCan("edit-settings");
  const canGenerate = useCan("send-messages");

  const [docs, setDocs] = useState<Record<LegalDocType, LegalDocument | null>>({
    anexo_01: null,
    anexo_02: null,
    minuta: null,
  });
  const [loading, setLoading] = useState(true);
  const [anexo01Open, setAnexo01Open] = useState(false);
  const [anexo02Open, setAnexo02Open] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/reservations/${reservationId}/legal-documents`);
      const json = await res.json();
      if (!res.ok) return;
      const byType: Record<LegalDocType, LegalDocument | null> = {
        anexo_01: null,
        anexo_02: null,
        minuta: null,
      };
      for (const doc of (json.documents ?? []) as LegalDocument[]) {
        byType[doc.doc_type] = doc;
      }
      setDocs(byType);
    } catch {
      toast.error("No se pudieron cargar los documentos legales");
    } finally {
      setLoading(false);
    }
  }, [reservationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function generateMinuta() {
    setBusy("minuta-generate");
    try {
      const res = await fetch(`/api/reservations/${reservationId}/legal-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_type: "minuta" }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "No se pudo generar la Minuta");
        return;
      }
      toast.success("Minuta generada");
      await load();
    } catch {
      toast.error("No se pudo generar la Minuta");
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(doc: LegalDocument, status: LegalDocStatus) {
    setBusy(`${doc.id}-${status}`);
    try {
      const res = await fetch(`/api/legal-documents/${doc.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "No se pudo actualizar el estado");
        return;
      }
      toast.success(`${DOC_LABELS[doc.doc_type]}: ${STATUS_LABEL[status].toLowerCase()}`);
      await load();
    } catch {
      toast.error("No se pudo actualizar el estado");
    } finally {
      setBusy(null);
    }
  }

  async function download(doc: LegalDocument) {
    try {
      const res = await fetch(`/api/legal-documents/${doc.id}/download`);
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        toast.error(json?.error ?? "No se pudo descargar el documento");
        return;
      }
      window.open(`/api/legal-documents/${doc.id}/download`, "_blank");
    } catch {
      toast.error("No se pudo descargar el documento");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Cargando documentos...
      </div>
    );
  }

  const anexo01 = docs.anexo_01;
  const anexo02 = docs.anexo_02;
  const minuta = docs.minuta;
  const canGenerateMinuta = !!anexo01 && !!anexo02;

  return (
    <div className="space-y-2">
      {/* Anexo 01 */}
      <DocRow
        label={DOC_LABELS.anexo_01}
        doc={anexo01}
        busy={busy}
        canApprove={canApprove}
        canGenerate={canGenerate}
        onGenerate={() => setAnexo01Open(true)}
        onEdit={() => setAnexo01Open(true)}
        onApprove={(d) => setStatus(d, "aprobado")}
        onReject={(d) => setStatus(d, "rechazado")}
        onDownload={download}
      />
      {/* Anexo 02 */}
      <DocRow
        label={DOC_LABELS.anexo_02}
        doc={anexo02}
        busy={busy}
        canApprove={canApprove}
        canGenerate={canGenerate}
        onGenerate={() => setAnexo02Open(true)}
        onEdit={() => setAnexo02Open(true)}
        onApprove={(d) => setStatus(d, "aprobado")}
        onReject={(d) => setStatus(d, "rechazado")}
        onDownload={download}
      />
      {/* Minuta */}
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm text-foreground">
            <FileText className="h-4 w-4 text-muted-foreground" />
            {DOC_LABELS.minuta}
          </span>
          {minuta && (
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs font-medium",
                STATUS_BADGE[minuta.status],
              )}
            >
              {STATUS_LABEL[minuta.status]}
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {!minuta ? (
            <GatedButton
              size="sm"
              canAct={canGenerate && canGenerateMinuta}
              gateReason={
                canGenerateMinuta ? "generar minuta" : "generar minuta (falta Anexo 01/02)"
              }
              disabled={busy === "minuta-generate"}
              onClick={generateMinuta}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {busy === "minuta-generate" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Generar Minuta
            </GatedButton>
          ) : (
            <>
              <GatedButton
                size="sm"
                variant="outline"
                canAct={canGenerate && canGenerateMinuta}
                gateReason="regenerar minuta"
                disabled={busy === "minuta-generate"}
                onClick={generateMinuta}
                className="border-border bg-transparent text-foreground hover:bg-muted"
              >
                <Pencil className="mr-1 h-3.5 w-3.5" />
                Regenerar
              </GatedButton>
              {minuta.status === "pendiente" && (
                <>
                  <GatedButton
                    size="sm"
                    canAct={canApprove}
                    gateReason="aprobar minuta"
                    disabled={!!busy}
                    onClick={() => setStatus(minuta, "aprobado")}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    <Check className="mr-1 h-3.5 w-3.5" />
                    Aprobar
                  </GatedButton>
                  <GatedButton
                    size="sm"
                    canAct={canApprove}
                    gateReason="rechazar minuta"
                    disabled={!!busy}
                    onClick={() => setStatus(minuta, "rechazado")}
                    className="bg-red-600 text-white hover:bg-red-700"
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    Rechazar
                  </GatedButton>
                </>
              )}
              {minuta.status === "aprobado" && (
                <GatedButton
                  size="sm"
                  canAct={canApprove}
                  gateReason="marcar lista para firma"
                  disabled={!!busy}
                  onClick={() => setStatus(minuta, "listo_para_firma")}
                  className="bg-green-600 text-white hover:bg-green-700"
                >
                  Marcar Listo para Firma
                </GatedButton>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => download(minuta)}
                className="border-border bg-transparent text-foreground hover:bg-muted"
              >
                <Download className="mr-1 h-3.5 w-3.5" />
                Descargar
              </Button>
            </>
          )}
        </div>
      </div>

      <Anexo01Form
        open={anexo01Open}
        onOpenChange={setAnexo01Open}
        reservationId={reservationId}
        contactName={contactName}
        existingDoc={anexo01}
        onSaved={load}
      />
      <Anexo02Form
        open={anexo02Open}
        onOpenChange={setAnexo02Open}
        reservationId={reservationId}
        defaultTotal={reservationTotal}
        currency={currency}
        existingDoc={anexo02}
        onSaved={load}
      />
    </div>
  );
}

function DocRow({
  label,
  doc,
  busy,
  canApprove,
  canGenerate,
  onGenerate,
  onEdit,
  onApprove,
  onReject,
  onDownload,
}: {
  label: string;
  doc: LegalDocument | null;
  busy: string | null;
  canApprove: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  onEdit: () => void;
  onApprove: (doc: LegalDocument) => void;
  onReject: (doc: LegalDocument) => void;
  onDownload: (doc: LegalDocument) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm text-foreground">
          <FileText className="h-4 w-4 text-muted-foreground" />
          {label}
        </span>
        {doc && (
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs font-medium",
              STATUS_BADGE[doc.status],
            )}
          >
            {STATUS_LABEL[doc.status]}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {!doc ? (
          <GatedButton
            size="sm"
            canAct={canGenerate}
            gateReason="generar documentos"
            onClick={onGenerate}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Generar
          </GatedButton>
        ) : (
          <>
            <GatedButton
              size="sm"
              variant="outline"
              canAct={canGenerate}
              gateReason="editar documentos"
              onClick={onEdit}
              className="border-border bg-transparent text-foreground hover:bg-muted"
            >
              <Pencil className="mr-1 h-3.5 w-3.5" />
              Editar
            </GatedButton>
            {doc.status === "pendiente" && (
              <>
                <GatedButton
                  size="sm"
                  canAct={canApprove}
                  gateReason="aprobar documentos"
                  disabled={!!busy}
                  onClick={() => onApprove(doc)}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Check className="mr-1 h-3.5 w-3.5" />
                  Aprobar
                </GatedButton>
                <GatedButton
                  size="sm"
                  canAct={canApprove}
                  gateReason="rechazar documentos"
                  disabled={!!busy}
                  onClick={() => onReject(doc)}
                  className="bg-red-600 text-white hover:bg-red-700"
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Rechazar
                </GatedButton>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDownload(doc)}
              className="border-border bg-transparent text-foreground hover:bg-muted"
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Descargar
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
