"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import type {
  Contact,
  PaymentMethod,
  Profile,
  RealEstateProject,
  RealEstateUnit,
} from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ReservationFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selects a project + unit, e.g. arriving from "Separar" on a unit card. */
  initialUnitId?: string | null;
  onSaved: () => void;
}

export function ReservationForm({
  open,
  onOpenChange,
  initialUnitId,
  onSaved,
}: ReservationFormProps) {
  const supabase = createClient();
  const { accountId, profile } = useAuth();

  const [contactId, setContactId] = useState("");
  const [advisorId, setAdvisorId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(new Set());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("voucher");
  const [notes, setNotes] = useState("");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [projects, setProjects] = useState<RealEstateProject[]>([]);
  const [units, setUnits] = useState<RealEstateUnit[]>([]);
  const [unitsLoading, setUnitsLoading] = useState(false);

  const [saving, setSaving] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setContactId("");
    setAdvisorId("");
    setProjectId("");
    setSelectedUnitIds(new Set());
    setPaymentMethod("voucher");
    setNotes("");
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load supporting data (contacts, advisors, projects) once open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [c, p, pr] = await Promise.all([
        supabase.from("contacts").select("*").order("name"),
        supabase.from("profiles").select("*").order("full_name"),
        supabase
          .from("real_estate_projects")
          .select("*")
          .neq("status", "sold_out")
          .order("name"),
      ]);
      if (cancelled) return;
      setContacts((c.data ?? []) as Contact[]);
      setProfiles((p.data ?? []) as Profile[]);
      setProjects((pr.data ?? []) as RealEstateProject[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  const loadUnitsForProject = useCallback(
    async (pid: string) => {
      setUnitsLoading(true);
      const { data } = await supabase
        .from("real_estate_units")
        .select("*")
        .eq("project_id", pid)
        .eq("status", "disponible")
        .order("code");
      setUnits((data ?? []) as RealEstateUnit[]);
      setUnitsLoading(false);
    },
    [supabase],
  );

  // When a unit is pre-selected (deep link from "Separar"), resolve its
  // project first so the unit list loads with it already checked.
  useEffect(() => {
    if (!open || !initialUnitId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("real_estate_units")
        .select("*")
        .eq("id", initialUnitId)
        .maybeSingle();
      if (cancelled || !data) return;
      const unit = data as RealEstateUnit;
      setProjectId(unit.project_id);
      setSelectedUnitIds(new Set([unit.id]));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialUnitId, supabase]);

  useEffect(() => {
    if (!projectId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUnits([]);
      return;
    }
    void loadUnitsForProject(projectId);
  }, [projectId, loadUnitsForProject]);

  function toggleUnit(id: string) {
    setSelectedUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedUnits = units.filter((u) => selectedUnitIds.has(u.id));
  const totalAmount = selectedUnits.reduce((sum, u) => sum + (u.price ?? 0), 0);
  const currency = selectedUnits[0]?.currency ?? "PEN";

  async function handleSave() {
    if (!contactId) {
      toast.error("Selecciona un cliente");
      return;
    }
    if (selectedUnitIds.size === 0) {
      toast.error("Selecciona al menos una unidad");
      return;
    }
    if (!accountId) {
      toast.error("Tu perfil no está vinculado a una cuenta.");
      return;
    }
    setSaving(true);

    const { data: reservation, error } = await supabase
      .from("reservations")
      .insert({
        account_id: accountId,
        contact_id: contactId,
        advisor_id: advisorId || profile?.id || null,
        total_amount: totalAmount,
        currency,
        payment_method: paymentMethod,
        notes: notes.trim() || null,
        status: "pendiente",
      })
      .select("id")
      .single();

    if (error || !reservation) {
      toast.error("No se pudo crear la separación");
      setSaving(false);
      return;
    }

    const junctionRows = Array.from(selectedUnitIds).map((unitId) => ({
      reservation_id: reservation.id,
      unit_id: unitId,
    }));
    const { error: junctionError } = await supabase
      .from("reservation_units")
      .insert(junctionRows);
    if (junctionError) {
      toast.error("Separación creada, pero no se pudieron vincular todas las unidades");
    }

    const { error: unitsError } = await supabase
      .from("real_estate_units")
      .update({ status: "reservado" })
      .in("id", Array.from(selectedUnitIds));
    if (unitsError) {
      toast.error("Separación creada, pero no se pudo actualizar el estado de las unidades");
    }

    setSaving(false);
    toast.success("Separación creada");
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
            <SheetTitle className="text-popover-foreground">Nueva Separación</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Cliente</Label>
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">Selecciona un cliente</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.phone}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Asesor</Label>
              <select
                value={advisorId}
                onChange={(e) => setAdvisorId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">Yo (asesor actual)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Proyecto</Label>
              <select
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setSelectedUnitIds(new Set());
                }}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">Selecciona un proyecto</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {projectId && (
              <div className="grid gap-2">
                <Label className="text-muted-foreground">
                  Unidades disponibles (selecciona una o más)
                </Label>
                {unitsLoading ? (
                  <div className="flex items-center justify-center py-4 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Cargando...
                  </div>
                ) : units.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No hay unidades disponibles en este proyecto.
                  </p>
                ) : (
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                    {units.map((u) => (
                      <label
                        key={u.id}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                      >
                        <span className="flex items-center gap-2 text-sm text-foreground">
                          <input
                            type="checkbox"
                            checked={selectedUnitIds.has(u.id)}
                            onChange={() => toggleUnit(u.id)}
                            className="h-4 w-4 rounded border-border"
                          />
                          {u.code}
                          {u.area_total != null && (
                            <span className="text-xs text-muted-foreground">
                              ({u.area_total} m²)
                            </span>
                          )}
                        </span>
                        {u.price != null && (
                          <span className="text-xs text-muted-foreground">
                            {formatCurrency(u.price, u.currency)}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {selectedUnitIds.size > 0 && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                <p className="text-xs text-muted-foreground">
                  Monto total ({selectedUnitIds.size} unidad
                  {selectedUnitIds.size > 1 ? "es" : ""})
                </p>
                <p className="text-lg font-bold text-foreground">
                  {formatCurrency(totalAmount, currency)}
                </p>
              </div>
            )}

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Método de pago</Label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="voucher">Voucher (transferencia)</option>
                <option value="online">Pago en línea</option>
                <option value="mixed">Mixto</option>
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Notas</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Detalles adicionales..."
                className="min-h-[80px] border-border bg-muted text-foreground"
              />
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
                disabled={saving || !contactId || selectedUnitIds.size === 0}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? "Guardando..." : "Crear Separación"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
