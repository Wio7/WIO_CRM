"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StoreSettingsRow } from "./types";

const DEFAULTS: StoreSettingsRow = {
  enabled: true,
  whatsapp: "",
  yape_number: "",
  yape_holder: "",
  mercadopago_holder: "",
  mercadopago_link: "",
  shipping_note: "",
  currency: "PEN",
};

type Draft = { [K in keyof StoreSettingsRow]: StoreSettingsRow[K] extends boolean ? boolean : string };

const toDraft = (s: StoreSettingsRow | null): Draft => {
  const b = s ?? DEFAULTS;
  return {
    enabled: b.enabled,
    whatsapp: b.whatsapp ?? "",
    yape_number: b.yape_number ?? "",
    yape_holder: b.yape_holder ?? "",
    mercadopago_holder: b.mercadopago_holder ?? "",
    mercadopago_link: b.mercadopago_link ?? "",
    shipping_note: b.shipping_note ?? "",
    currency: b.currency,
  };
};

const orNull = (s: string) => s.trim() || null;

export function SettingsPanel({
  accountId,
  settings,
  canWrite,
  onSaved,
}: {
  accountId: string;
  settings: StoreSettingsRow | null;
  canWrite: boolean;
  onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(() => toDraft(settings));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  async function save() {
    const currency = d.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return toast.error("La moneda debe ser un código de 3 letras (ej. PEN).");
    setSaving(true);
    const { error } = await createClient()
      .from("store_settings")
      .upsert(
        {
          account_id: accountId,
          enabled: d.enabled,
          whatsapp: orNull(d.whatsapp),
          yape_number: orNull(d.yape_number),
          yape_holder: orNull(d.yape_holder),
          mercadopago_holder: orNull(d.mercadopago_holder),
          mercadopago_link: orNull(d.mercadopago_link),
          shipping_note: orNull(d.shipping_note),
          currency,
        },
        { onConflict: "account_id" },
      );
    setSaving(false);
    if (error) return toast.error("No se pudo guardar: " + error.message);
    toast.success("Ajustes guardados");
    onSaved();
  }

  const field = (id: keyof Draft, label: string, hint?: string) => (
    <div className="space-y-1">
      <Label htmlFor={"s-" + id}>{label}</Label>
      <Input
        id={"s-" + id}
        value={String(d[id])}
        disabled={!canWrite}
        onChange={(e) => set(id, e.target.value as never)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <div className="max-w-xl space-y-4">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={d.enabled} disabled={!canWrite} onChange={(e) => set("enabled", e.target.checked)} />
        Tienda activa (si la apagas, la tienda web no recibe pedidos)
      </label>
      {field("whatsapp", "WhatsApp de la tienda", "Con código de país, ej. +51919649875")}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("yape_number", "Número de Yape")}
        {field("yape_holder", "Titular de Yape")}
        {field("mercadopago_holder", "Titular de Mercado Pago")}
        {field("currency", "Moneda")}
      </div>
      {field("mercadopago_link", "Enlace de Mercado Pago (opcional)")}
      <div className="space-y-1">
        <Label htmlFor="s-shipping">Nota de envíos</Label>
        <Textarea
          id="s-shipping"
          rows={3}
          value={d.shipping_note}
          disabled={!canWrite}
          onChange={(e) => set("shipping_note", e.target.value)}
        />
      </div>
      {canWrite && (
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Guardar ajustes
        </Button>
      )}
    </div>
  );
}
