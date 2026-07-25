"use client";

import { useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";
import type { PaymentType } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";

interface PaymentUploadProps {
  reservationId: string;
  accountId: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function PaymentUpload({
  reservationId,
  accountId,
  onSaved,
  onCancel,
}: PaymentUploadProps) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [type, setType] = useState<PaymentType>("voucher");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [voucherUrl, setVoucherUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.document) {
      toast.error("El archivo es demasiado grande");
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("reservation-docs", file);
      setVoucherUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo subir el comprobante");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      toast.error("Ingresa un monto válido");
      return;
    }
    if (type === "voucher" && !voucherUrl) {
      toast.error("Sube el comprobante de la transferencia");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("reservation_payments").insert({
      reservation_id: reservationId,
      account_id: accountId,
      type,
      amount: parsedAmount,
      voucher_url: voucherUrl || null,
      reference: reference.trim() || null,
      status: "pendiente",
    });
    setSaving(false);
    if (error) {
      toast.error("No se pudo registrar el pago");
      return;
    }
    toast.success("Pago registrado, pendiente de aprobación");
    onSaved();
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label className="text-muted-foreground">Tipo</Label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as PaymentType)}
            className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
          >
            <option value="voucher">Voucher</option>
            <option value="culqi">Culqi (online)</option>
            <option value="transferencia">Transferencia</option>
          </select>
        </div>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">Monto</Label>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="border-border bg-muted text-foreground"
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label className="text-muted-foreground">Referencia (opcional)</Label>
        <Input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="N° de operación"
          className="border-border bg-muted text-foreground"
        />
      </div>

      {type === "voucher" && (
        <div className="grid gap-2">
          <Label className="text-muted-foreground">Comprobante</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
          {voucherUrl ? (
            <div className="flex items-center justify-between rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
              <span className="flex items-center gap-1.5 truncate">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                Comprobante adjunto
              </span>
              <button
                type="button"
                onClick={() => setVoucherUrl("")}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="border-border bg-transparent text-foreground hover:bg-muted"
            >
              {uploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="mr-2 h-4 w-4" />
              )}
              {uploading ? "Subiendo..." : "Subir comprobante"}
            </Button>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground"
        >
          Cancelar
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? "Guardando..." : "Registrar pago"}
        </Button>
      </div>
    </div>
  );
}
