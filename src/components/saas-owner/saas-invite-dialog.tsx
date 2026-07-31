"use client";

// ============================================================
// SaasInviteDialog
//
// Cross-account counterpart to src/components/settings/invite-member-dialog.tsx
// — same two-step flow (form → result link), but targets an
// explicit account (from the /saas-owner list) instead of the
// caller's own account, and is themed to match the SaaS owner
// panel's dark/neon look instead of the app's standard theme
// tokens, so the modal feels like part of that distinct view.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, Mail, MessageCircle, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type InviteRole = "admin" | "agent" | "viewer";

interface SaasInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
}

const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: "1", label: "1 día" },
  { value: "7", label: "7 días" },
  { value: "30", label: "30 días" },
];

const ROLE_DESCRIPTIONS: Record<InviteRole, string> = {
  admin: "Puede invitar miembros, gestionar la configuración y editar todo.",
  agent: "Puede usar la bandeja, contactos, difusiones, automatizaciones y flujos.",
  viewer: "Acceso de solo lectura en todas las páginas.",
};

const MAX_LABEL_LEN = 80;

interface CreatedInvite {
  url: string;
  role: InviteRole;
  expiresInDays: number;
}

export function SaasInviteDialog({
  open,
  onOpenChange,
  accountId,
  accountName,
}: SaasInviteDialogProps) {
  const [role, setRole] = useState<InviteRole>("agent");
  const [expiry, setExpiry] = useState<string>("7");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreatedInvite | null>(null);

  function reset() {
    setRole("agent");
    setExpiry("7");
    setLabel("");
    setResult(null);
    setSubmitting(false);
  }

  async function handleCreate() {
    const trimmedLabel = label.trim();
    if (trimmedLabel.length > MAX_LABEL_LEN) {
      toast.error(`La etiqueta debe tener ${MAX_LABEL_LEN} caracteres o menos`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/accounts/${accountId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          expiresInDays: Number(expiry),
          label: trimmedLabel || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "No se pudo crear la invitación");
        return;
      }

      setResult({ url: data.url, role, expiresInDays: data.expiresInDays });
    } catch {
      toast.error("No se pudo contactar al servidor. ¿Intentar de nuevo?");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToClipboard() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success("Link de invitación copiado");
    } catch {
      toast.error("No se pudo copiar automáticamente — copia el link manualmente");
    }
  }

  function whatsappShareUrl(url: string): string {
    const message = `Únete a ${accountName} en Wio CRM con este link (válido por ${result?.expiresInDays} días): ${url}`;
    return `https://wa.me/?text=${encodeURIComponent(message)}`;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-[#121214] border border-white/5 text-white max-w-md rounded-[2rem] p-6 shadow-2xl relative">
        <div className="absolute right-4 top-4">
          <Button
            onClick={() => onOpenChange(false)}
            variant="ghost"
            className="h-8 w-8 rounded-full border border-white/5 bg-white/5 hover:bg-white/10 p-0 text-muted-foreground hover:text-white"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {result ? (
          <>
            <DialogHeader className="space-y-2">
              <DialogTitle className="flex items-center gap-2 text-xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white to-neutral-400">
                <Sparkles className="size-4 text-primary" />
                INVITACIÓN CREADA
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Comparte este link para que se una a{" "}
                <span className="font-semibold text-white">{accountName}</span> como{" "}
                <span className="font-semibold text-white">{result.role}</span>. Válido por{" "}
                {result.expiresInDays} día{result.expiresInDays === 1 ? "" : "s"}.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={result.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-11 bg-[#0d0d0f] border-white/5 rounded-xl text-white font-mono text-xs"
                />
                <Button
                  type="button"
                  onClick={copyToClipboard}
                  className="bg-primary hover:bg-primary/95 text-[#070708] font-black rounded-xl shrink-0"
                >
                  <Copy className="h-4 w-4" />
                  Copiar
                </Button>
              </div>

              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <strong className="font-semibold text-amber-200">Guarda este link ahora.</strong>{" "}
                No se almacena en texto plano — al cerrar este modal desaparece.
              </div>

              <a
                href={whatsappShareUrl(result.url)}
                target="_blank"
                rel="noreferrer noopener"
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 h-11 text-xs uppercase tracking-widest font-bold text-white transition-colors"
              >
                <MessageCircle className="h-4 w-4" />
                Enviar por WhatsApp
              </a>
            </div>

            <DialogFooter className="pt-2 border-t border-white/5">
              <Button
                onClick={() => onOpenChange(false)}
                className="w-full bg-primary hover:bg-primary/95 text-[#070708] font-black rounded-xl h-11 text-xs uppercase tracking-widest"
              >
                Listo
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white to-neutral-400">
                INVITAR A {accountName.toUpperCase()}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Genera un link de invitación de un solo uso para esta cuenta. Se comparte
                manualmente (WhatsApp, correo, etc.) — no se envía automáticamente.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-widest font-black text-muted-foreground">
                  Rol
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as InviteRole)}
                  className="h-11 w-full rounded-xl border border-white/5 bg-[#0d0d0f] px-3 text-xs text-white outline-none focus:border-primary"
                >
                  <option value="admin">Admin</option>
                  <option value="agent">Agente</option>
                  <option value="viewer">Espectador</option>
                </select>
                <p className="text-[10px] text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-widest font-black text-muted-foreground">
                  Link válido por
                </label>
                <select
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  className="h-11 w-full rounded-xl border border-white/5 bg-[#0d0d0f] px-3 text-xs text-white outline-none focus:border-primary"
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-widest font-black text-muted-foreground flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 text-primary" />
                  Correo (referencia, opcional)
                </label>
                <Input
                  placeholder="persona@correo.com"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={MAX_LABEL_LEN}
                  className="h-11 bg-[#0d0d0f] border-white/5 rounded-xl text-white placeholder-muted-foreground/45 text-xs"
                />
                <p className="text-[10px] text-muted-foreground">
                  Solo para tu referencia — el link no queda atado a esa dirección.
                </p>
              </div>
            </div>

            <DialogFooter className="pt-4 border-t border-white/5 flex gap-2">
              <Button
                type="button"
                onClick={() => onOpenChange(false)}
                variant="outline"
                className="border-white/5 bg-white/5 hover:bg-white/10 text-white rounded-xl h-11 text-xs uppercase tracking-widest font-bold flex-1"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleCreate}
                disabled={submitting}
                className="bg-primary hover:bg-primary/95 text-[#070708] font-black rounded-xl h-11 text-xs uppercase tracking-widest flex-1 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generando...
                  </>
                ) : (
                  "Generar link"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
