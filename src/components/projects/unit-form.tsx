"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealEstateUnit, UnitRoom, UnitStatus } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

interface UnitFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  accountId: string;
  unit?: RealEstateUnit | null;
  onSaved: () => void;
}

const EMPTY_ROOM: UnitRoom = { name: "", area: 0 };

export function UnitForm({
  open,
  onOpenChange,
  projectId,
  accountId,
  unit,
  onSaved,
}: UnitFormProps) {
  const supabase = createClient();

  const [code, setCode] = useState("");
  const [manzana, setManzana] = useState("");
  const [loteNumber, setLoteNumber] = useState("");
  const [areaTotal, setAreaTotal] = useState("");
  const [areaTechada, setAreaTechada] = useState("");
  const [areaNoTechada, setAreaNoTechada] = useState("");
  const [rooms, setRooms] = useState<UnitRoom[]>([]);
  const [floors, setFloors] = useState("1");
  const [heightFloor, setHeightFloor] = useState("");
  const [heightTotal, setHeightTotal] = useState("");
  const [material, setMaterial] = useState("Material noble (albañilería y concreto)");
  const [services, setServices] = useState("Luz, agua y desagüe tradicional");
  const [ventilation, setVentilation] = useState("Natural");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("PEN");
  const [status, setStatus] = useState<UnitStatus>("disponible");

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    if (unit) {
      setCode(unit.code);
      setManzana(unit.manzana ?? "");
      setLoteNumber(unit.lote_number != null ? String(unit.lote_number) : "");
      setAreaTotal(unit.area_total != null ? String(unit.area_total) : "");
      setAreaTechada(unit.area_techada != null ? String(unit.area_techada) : "");
      setAreaNoTechada(unit.area_no_techada != null ? String(unit.area_no_techada) : "");
      setRooms(unit.rooms?.length ? unit.rooms : []);
      setFloors(String(unit.floors ?? 1));
      setHeightFloor(unit.height_floor != null ? String(unit.height_floor) : "");
      setHeightTotal(unit.height_total != null ? String(unit.height_total) : "");
      setMaterial(unit.material ?? "");
      setServices(unit.services ?? "");
      setVentilation(unit.ventilation ?? "");
      setPrice(unit.price != null ? String(unit.price) : "");
      setCurrency(unit.currency || "PEN");
      setStatus(unit.status ?? "disponible");
    } else {
      setCode("");
      setManzana("");
      setLoteNumber("");
      setAreaTotal("");
      setAreaTechada("");
      setAreaNoTechada("");
      setRooms([]);
      setFloors("1");
      setHeightFloor("2.60");
      setHeightTotal("2.95");
      setMaterial("Material noble (albañilería y concreto)");
      setServices("Luz, agua y desagüe tradicional");
      setVentilation("Natural");
      setPrice("");
      setCurrency("PEN");
      setStatus("disponible");
    }
  }, [open, unit]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function addRoom() {
    setRooms((prev) => [...prev, { ...EMPTY_ROOM }]);
  }

  function updateRoom(index: number, field: keyof UnitRoom, value: string) {
    setRooms((prev) =>
      prev.map((r, i) =>
        i === index
          ? { ...r, [field]: field === "area" ? Number(value) || 0 : value }
          : r,
      ),
    );
  }

  function removeRoom(index: number) {
    setRooms((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (!code.trim()) {
      toast.error("El código de la unidad es requerido");
      return;
    }
    setSaving(true);

    const payload = {
      code: code.trim(),
      manzana: manzana.trim() || null,
      lote_number: loteNumber ? parseInt(loteNumber, 10) : null,
      area_total: areaTotal ? parseFloat(areaTotal) : null,
      area_techada: areaTechada ? parseFloat(areaTechada) : null,
      area_no_techada: areaNoTechada ? parseFloat(areaNoTechada) : null,
      rooms: rooms.filter((r) => r.name.trim()),
      floors: parseInt(floors, 10) || 1,
      height_floor: heightFloor ? parseFloat(heightFloor) : null,
      height_total: heightTotal ? parseFloat(heightTotal) : null,
      material: material.trim() || null,
      services: services.trim() || null,
      ventilation: ventilation.trim() || null,
      price: price ? parseFloat(price) : null,
      currency,
      status,
    };

    if (unit) {
      const { error } = await supabase
        .from("real_estate_units")
        .update(payload)
        .eq("id", unit.id);
      if (error) {
        toast.error("No se pudo guardar la unidad");
        setSaving(false);
        return;
      }
    } else {
      const { error } = await supabase
        .from("real_estate_units")
        .insert({ ...payload, project_id: projectId, account_id: accountId });
      if (error) {
        toast.error("No se pudo crear la unidad");
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(unit ? "Unidad actualizada" : "Unidad creada");
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!unit) return;
    setDeleting(true);
    const { error } = await supabase
      .from("real_estate_units")
      .delete()
      .eq("id", unit.id);
    setDeleting(false);
    if (error) {
      toast.error("No se pudo eliminar la unidad");
      return;
    }
    toast.success("Unidad eliminada");
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
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
              {unit ? "Editar Unidad" : "Nueva Unidad"}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Código</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="MZ J LOTE 3"
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Estado</Label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as UnitStatus)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="disponible">Disponible</option>
                  <option value="reservado">Reservado</option>
                  <option value="vendido">Vendido</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Manzana</Label>
                <Input
                  value={manzana}
                  onChange={(e) => setManzana(e.target.value)}
                  placeholder="MZ J"
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">N° Lote</Label>
                <Input
                  type="number"
                  value={loteNumber}
                  onChange={(e) => setLoteNumber(e.target.value)}
                  placeholder="3"
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Área total (m²)</Label>
                <Input
                  type="number"
                  value={areaTotal}
                  onChange={(e) => setAreaTotal(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Área techada (m²)</Label>
                <Input
                  type="number"
                  value={areaTechada}
                  onChange={(e) => setAreaTechada(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Área no techada (m²)</Label>
                <Input
                  type="number"
                  value={areaNoTechada}
                  onChange={(e) => setAreaNoTechada(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>

            {/* Ambientes */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label className="text-muted-foreground">Ambientes</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addRoom}
                  className="h-7 text-primary hover:text-primary"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Agregar
                </Button>
              </div>
              {rooms.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Sin ambientes registrados. Ej: Sala-Comedor, Cocina, Dormitorio principal.
                </p>
              )}
              <div className="space-y-2">
                {rooms.map((room, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={room.name}
                      onChange={(e) => updateRoom(i, "name", e.target.value)}
                      placeholder="Nombre (ej. Cocina)"
                      className="border-border bg-muted text-foreground"
                    />
                    <Input
                      type="number"
                      value={room.area || ""}
                      onChange={(e) => updateRoom(i, "area", e.target.value)}
                      placeholder="m²"
                      className="w-24 border-border bg-muted text-foreground"
                    />
                    <button
                      type="button"
                      onClick={() => removeRoom(i)}
                      className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Pisos</Label>
                <Input
                  type="number"
                  value={floors}
                  onChange={(e) => setFloors(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Altura piso (m)</Label>
                <Input
                  type="number"
                  value={heightFloor}
                  onChange={(e) => setHeightFloor(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Altura total (m)</Label>
                <Input
                  type="number"
                  value={heightTotal}
                  onChange={(e) => setHeightTotal(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Material</Label>
              <Input
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Servicios básicos</Label>
                <Input
                  value={services}
                  onChange={(e) => setServices(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Ventilación</Label>
                <Input
                  value={ventilation}
                  onChange={(e) => setVentilation(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>

            <div className="grid grid-cols-[1fr_100px] gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Precio</Label>
                <Input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Moneda</Label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="PEN">PEN</option>
                  <option value="USD">USD</option>
                </select>
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
                disabled={saving || !code.trim()}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? "Guardando..." : unit ? "Guardar cambios" : "Crear unidad"}
              </Button>
            </div>

            {unit &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <span className="text-red-300">¿Eliminar esta unidad?</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? "Eliminando..." : "Confirmar"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  Eliminar unidad
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
