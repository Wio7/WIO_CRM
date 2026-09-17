"use client";

// ============================================================
// Create a payment plan and its instalments in one go.
//
// The office already knows the deal in the terms it sells: price, down
// payment, how many months, which day they pay. From those four the
// instalment amount and every due date follow, so the form computes the
// schedule in front of the advisor before saving — a plan that saves
// silently and turns out wrong is a collections problem for years.
//
// Saving writes the plan, then its instalments (migration 043).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import type { Contact, RealEstateUnit } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface PaymentPlanFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/** Same day next month, clamped: a 31 due day lands on the 30th in April. */
function addMonthsKeepingDay(base: Date, months: number, dueDay: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth() + months, 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dueDay, lastDay));
  return d;
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

export function PaymentPlanForm({
  open,
  onOpenChange,
  onSaved,
}: PaymentPlanFormProps) {
  const supabase = createClient();
  const { accountId, profile, defaultCurrency } = useAuth();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [units, setUnits] = useState<RealEstateUnit[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [saving, setSaving] = useState(false);

  const [contactId, setContactId] = useState("");
  const [unitId, setUnitId] = useState("");
  // La moneda de la cuenta, no una constante: el plan que se guarda y
  // lo que el cliente ve después tienen que decir lo mismo.
  const currency = defaultCurrency;
  const [total, setTotal] = useState("");
  const [down, setDown] = useState("0");
  const [months, setMonths] = useState("70");
  const [dueDay, setDueDay] = useState("5");
  const [firstDue, setFirstDue] = useState(() => {
    const d = new Date();
    return iso(new Date(d.getFullYear(), d.getMonth() + 1, 5));
  });
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoadingLists(true);
      const [{ data: cs }, { data: us }] = await Promise.all([
        supabase.from("contacts").select("*").order("name"),
        supabase
          .from("real_estate_units")
          .select("*")
          .in("status", ["disponible", "reservado", "vendido"])
          .order("code"),
      ]);
      if (cancelled) return;
      setContacts(cs ?? []);
      setUnits(us ?? []);
      setLoadingLists(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  // The schedule, recomputed as the advisor types. This is what gets
  // saved — no second calculation at write time that could disagree.
  const schedule = useMemo(() => {
    const totalNum = Number(total) || 0;
    const downNum = Number(down) || 0;
    const monthsNum = Math.max(1, Math.trunc(Number(months) || 0));
    const day = Math.min(31, Math.max(1, Math.trunc(Number(dueDay) || 1)));
    const financed = Math.max(0, totalNum - downNum);
    // Cents on the last instalment rather than spread across all of them,
    // so every month is the round number the client was quoted.
    const monthly = Math.round((financed / monthsNum) * 100) / 100;
    const base = firstDue ? new Date(`${firstDue}T00:00:00`) : new Date();
    const rows = Array.from({ length: monthsNum }, (_, k) => {
      const last = k === monthsNum - 1;
      const amount = last
        ? Math.round((financed - monthly * (monthsNum - 1)) * 100) / 100
        : monthly;
      return {
        number: k + 1,
        amount,
        due_date: iso(addMonthsKeepingDay(base, k, day)),
      };
    });
    return { financed, monthly, rows, monthsNum, day };
  }, [total, down, months, dueDay, firstDue]);

  const guardar = useCallback(async () => {
    if (!accountId) {
      toast.error("Tu cuenta todavía está cargando, espera un momento");
      return;
    }
    if (!contactId) {
      toast.error("Elige el cliente");
      return;
    }
    if (schedule.financed <= 0) {
      toast.error("El precio tiene que ser mayor que la inicial");
      return;
    }

    setSaving(true);
    const { data: plan, error } = await supabase
      .from("payment_plans")
      .insert({
        account_id: accountId,
        contact_id: contactId,
        unit_id: unitId || null,
        currency,
        total_amount: Number(total) || 0,
        down_payment: Number(down) || 0,
        installments_count: schedule.monthsNum,
        monthly_amount: schedule.monthly,
        due_day: schedule.day,
        first_due_date: firstDue,
        notes: notes.trim() || null,
        created_by: profile?.id ?? null,
      })
      .select("id")
      .single();

    if (error || !plan) {
      setSaving(false);
      toast.error("No se pudo crear el plan");
      console.error("[payment-plan] insert plan:", error?.message);
      return;
    }

    const { error: errCuotas } = await supabase.from("installments").insert(
      schedule.rows.map((r) => ({
        plan_id: plan.id,
        account_id: accountId,
        number: r.number,
        amount: r.amount,
        due_date: r.due_date,
      })),
    );
    setSaving(false);

    if (errCuotas) {
      // The plan exists but has no schedule: say so plainly instead of a
      // vague failure, because the advisor has to fix it, not retry blind.
      toast.error("El plan se creó pero sus cuotas no. Ábrelo y vuelve a generarlas.");
      console.error("[payment-plan] insert installments:", errCuotas.message);
      onSaved();
      return;
    }

    toast.success(`Plan creado con ${schedule.monthsNum} cuotas`);
    onOpenChange(false);
    onSaved();
  }, [
    accountId,
    contactId,
    currency,
    down,
    firstDue,
    notes,
    onOpenChange,
    onSaved,
    profile,
    schedule,
    supabase,
    total,
    unitId,
  ]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Nuevo plan de cuotas</SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="pp-cliente">Cliente</Label>
            <select
              id="pp-cliente"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              disabled={loadingLists}
              className="h-10 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value="">— Elige el cliente —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.phone}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pp-unidad">Lote o casa (opcional)</Label>
            <select
              id="pp-unidad"
              value={unitId}
              onChange={(e) => setUnitId(e.target.value)}
              disabled={loadingLists}
              className="h-10 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value="">— Sin unidad —</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code}
                  {u.manzana ? ` · Mz ${u.manzana}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="pp-total">Precio total</Label>
              <Input
                id="pp-total"
                type="number"
                min="0"
                step="100"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pp-inicial">Cuota inicial</Label>
              <Input
                id="pp-inicial"
                type="number"
                min="0"
                step="100"
                value={down}
                onChange={(e) => setDown(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="pp-meses">Cuotas</Label>
              <Input
                id="pp-meses"
                type="number"
                min="1"
                max="360"
                value={months}
                onChange={(e) => setMonths(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pp-dia">Día de pago</Label>
              <Input
                id="pp-dia"
                type="number"
                min="1"
                max="31"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pp-primera">Primera cuota</Label>
              <Input
                id="pp-primera"
                type="date"
                value={firstDue}
                onChange={(e) => setFirstDue(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pp-notas">Notas (opcional)</Label>
            <Textarea
              id="pp-notas"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="border-border bg-muted text-foreground"
            />
          </div>

          {/* Lo que se va a guardar, antes de guardarlo. */}
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Monto financiado</span>
              <span className="font-medium text-foreground">
                {formatCurrency(schedule.financed, currency)}
              </span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted-foreground">Cuota mensual</span>
              <span className="font-medium text-foreground">
                {formatCurrency(schedule.monthly, currency)}
              </span>
            </div>
            {schedule.rows.length > 0 && (
              <div className="mt-1 flex justify-between">
                <span className="text-muted-foreground">
                  {schedule.rows.length} cuotas, de
                </span>
                <span className="text-foreground">
                  {schedule.rows[0].due_date} a{" "}
                  {schedule.rows[schedule.rows.length - 1].due_date}
                </span>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pb-6">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              Cancelar
            </Button>
            <Button
              onClick={guardar}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Guardando...
                </>
              ) : (
                "Crear plan"
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
