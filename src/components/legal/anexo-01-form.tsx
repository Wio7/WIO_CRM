"use client";

import { useState, useEffect } from "react";
import type { Anexo01Data, AdditionalUnit, BuyerData, LegalDocument } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

interface Anexo01FormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservationId: string;
  contactName: string;
  existingDoc?: LegalDocument | null;
  onSaved: () => void;
}

const EMPTY_BUYER: BuyerData = {
  nombre: "",
  dni: "",
  estado_civil: "",
  ocupacion: "",
  profesion: "",
  nacionalidad: "Peruana",
  direccion: "",
  provincia: "",
  departamento: "Ica",
};

const EMPTY_ADDITIONAL: AdditionalUnit = { type: "Cochera", area: 0, description: "" };

function BuyerFields({
  buyer,
  onChange,
}: {
  buyer: BuyerData;
  onChange: (buyer: BuyerData) => void;
}) {
  const set = (field: keyof BuyerData, value: string) =>
    onChange({ ...buyer, [field]: value });

  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        <Label className="text-muted-foreground">Nombre completo</Label>
        <Input
          value={buyer.nombre}
          onChange={(e) => set("nombre", e.target.value)}
          className="border-border bg-muted text-foreground"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label className="text-muted-foreground">DNI</Label>
          <Input
            value={buyer.dni}
            onChange={(e) => set("dni", e.target.value)}
            className="border-border bg-muted text-foreground"
          />
        </div>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">Estado civil</Label>
          <select
            value={buyer.estado_civil}
            onChange={(e) => set("estado_civil", e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
          >
            <option value="">Selecciona</option>
            <option value="Soltero(a)">Soltero(a)</option>
            <option value="Casado(a)">Casado(a)</option>
            <option value="Divorciado(a)">Divorciado(a)</option>
            <option value="Viudo(a)">Viudo(a)</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label className="text-muted-foreground">Ocupación</Label>
          <Input
            value={buyer.ocupacion}
            onChange={(e) => set("ocupacion", e.target.value)}
            className="border-border bg-muted text-foreground"
          />
        </div>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">Profesión</Label>
          <Input
            value={buyer.profesion}
            onChange={(e) => set("profesion", e.target.value)}
            className="border-border bg-muted text-foreground"
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label className="text-muted-foreground">Nacionalidad</Label>
        <Input
          value={buyer.nacionalidad}
          onChange={(e) => set("nacionalidad", e.target.value)}
          className="border-border bg-muted text-foreground"
        />
      </div>
      <div className="grid gap-2">
        <Label className="text-muted-foreground">Dirección</Label>
        <Input
          value={buyer.direccion}
          onChange={(e) => set("direccion", e.target.value)}
          className="border-border bg-muted text-foreground"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label className="text-muted-foreground">Provincia</Label>
          <Input
            value={buyer.provincia}
            onChange={(e) => set("provincia", e.target.value)}
            className="border-border bg-muted text-foreground"
          />
        </div>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">Departamento</Label>
          <Input
            value={buyer.departamento}
            onChange={(e) => set("departamento", e.target.value)}
            className="border-border bg-muted text-foreground"
          />
        </div>
      </div>
    </div>
  );
}

export function Anexo01Form({
  open,
  onOpenChange,
  reservationId,
  contactName,
  existingDoc,
  onSaved,
}: Anexo01FormProps) {
  const [comprador, setComprador] = useState<BuyerData>(EMPTY_BUYER);
  const [tieneConyuge, setTieneConyuge] = useState(false);
  const [conyuge, setConyuge] = useState<BuyerData>(EMPTY_BUYER);
  const [adicionales, setAdicionales] = useState<AdditionalUnit[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (existingDoc) {
      const data = existingDoc.data as unknown as Anexo01Data;
      setComprador(data.comprador ?? { ...EMPTY_BUYER, nombre: contactName });
      setTieneConyuge(!!data.tiene_conyuge);
      setConyuge(data.conyuge ?? EMPTY_BUYER);
      setAdicionales(data.inmuebles_adicionales ?? []);
    } else {
      setComprador({ ...EMPTY_BUYER, nombre: contactName });
      setTieneConyuge(false);
      setConyuge(EMPTY_BUYER);
      setAdicionales([]);
    }
  }, [open, existingDoc, contactName]);

  function addAdicional() {
    setAdicionales((prev) => [...prev, { ...EMPTY_ADDITIONAL }]);
  }

  function updateAdicional(i: number, field: keyof AdditionalUnit, value: string) {
    setAdicionales((prev) =>
      prev.map((a, idx) =>
        idx === i ? { ...a, [field]: field === "area" ? Number(value) || 0 : value } : a,
      ),
    );
  }

  function removeAdicional(i: number) {
    setAdicionales((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    if (!comprador.nombre.trim()) {
      toast.error("El nombre del comprador es requerido");
      return;
    }
    setSaving(true);
    const payload: Anexo01Data = {
      comprador,
      tiene_conyuge: tieneConyuge,
      conyuge: tieneConyuge ? conyuge : undefined,
      inmuebles_adicionales: adicionales.filter((a) => a.type.trim()),
    };

    try {
      const res = await fetch(`/api/reservations/${reservationId}/legal-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_type: "anexo_01", data: payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "No se pudo generar el Anexo 01");
        return;
      }
      toast.success("Anexo 01 generado");
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error("No se pudo generar el Anexo 01");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              Anexo 01 — Datos del Comprador
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Comprador
              </p>
              <BuyerFields buyer={comprador} onChange={setComprador} />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">Cónyuge / Copropietario</p>
                <p className="text-xs text-muted-foreground">
                  Habilita un segundo titular en la compra
                </p>
              </div>
              <Switch checked={tieneConyuge} onCheckedChange={setTieneConyuge} />
            </div>

            {tieneConyuge && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Cónyuge / Copropietario
                </p>
                <BuyerFields buyer={conyuge} onChange={setConyuge} />
              </div>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Inmuebles Adicionales
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addAdicional}
                  className="h-7 text-primary hover:text-primary"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Agregar
                </Button>
              </div>
              {adicionales.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Ej: Cochera, Depósito, Estacionamiento, Depósito en sótano.
                </p>
              )}
              <div className="space-y-2">
                {adicionales.map((a, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      value={a.type}
                      onChange={(e) => updateAdicional(i, "type", e.target.value)}
                      className="h-9 w-32 shrink-0 rounded-lg border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
                    >
                      <option>Cochera</option>
                      <option>Depósito</option>
                      <option>Estacionamiento</option>
                      <option>Depósito en sótano</option>
                    </select>
                    <Input
                      type="number"
                      value={a.area || ""}
                      onChange={(e) => updateAdicional(i, "area", e.target.value)}
                      placeholder="m²"
                      className="w-20 border-border bg-muted text-foreground"
                    />
                    <Input
                      value={a.description}
                      onChange={(e) => updateAdicional(i, "description", e.target.value)}
                      placeholder="Descripción"
                      className="border-border bg-muted text-foreground"
                    />
                    <button
                      type="button"
                      onClick={() => removeAdicional(i)}
                      className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !comprador.nombre.trim()}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {saving ? "Generando..." : "Generar Anexo 01"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
