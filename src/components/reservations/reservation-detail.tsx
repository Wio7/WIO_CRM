"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type {
  Reservation,
  ReservationPayment,
  ReservationStatus,
} from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { PaymentUpload } from "@/components/reservations/payment-upload";
import { Check, Loader2, MessageCircle, Plus, X } from "lucide-react";
import { toast } from "sonner";

const STATUS_BADGE: Record<ReservationStatus, string> = {
  pendiente: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  aprobada: "border-primary/40 bg-primary/10 text-primary",
  rechazada: "border-red-500/40 bg-red-500/10 text-red-400",
  cerrada: "border-green-500/40 bg-green-500/10 text-green-400",
};

const STATUS_LABEL: Record<ReservationStatus, string> = {
  pendiente: "Pendiente",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  cerrada: "Cerrada",
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  aprobado: "Aprobado",
  rechazado: "Rechazado",
};

interface ReservationDetailProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservation: Reservation | null;
  onChanged: () => void;
}

export function ReservationDetail({
  open,
  onOpenChange,
  reservation,
  onChanged,
}: ReservationDetailProps) {
  const supabase = createClient();
  const { accountId, profile } = useAuth();
  const canApprove = useCan("edit-settings");
  const canAddPayment = useCan("send-messages");

  const [payments, setPayments] = useState<ReservationPayment[]>([]);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadPayments = useCallback(async () => {
    if (!reservation) return;
    setLoadingPayments(true);
    const { data } = await supabase
      .from("reservation_payments")
      .select("*")
      .eq("reservation_id", reservation.id)
      .order("created_at", { ascending: false });
    setPayments((data ?? []) as ReservationPayment[]);
    setLoadingPayments(false);
  }, [supabase, reservation]);

  useEffect(() => {
    if (!open || !reservation) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowPaymentForm(false);
    void loadPayments();
  }, [open, reservation, loadPayments]);

  if (!reservation) return null;

  const unitIds = (reservation.units ?? []).map((u) => u.id);

  async function updateStatus(status: ReservationStatus) {
    if (!reservation) return;
    setActionLoading(status);

    const payload: Record<string, unknown> = { status };
    if (status === "aprobada") {
      payload.approved_by = profile?.id ?? null;
      payload.approved_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from("reservations")
      .update(payload)
      .eq("id", reservation.id);

    if (error) {
      toast.error("No se pudo actualizar la separación");
      setActionLoading(null);
      return;
    }

    // Reflect the outcome on the linked units: rejection frees them up
    // again, closing marks the sale final.
    if (unitIds.length > 0) {
      if (status === "rechazada") {
        await supabase
          .from("real_estate_units")
          .update({ status: "disponible" })
          .in("id", unitIds);
      } else if (status === "cerrada") {
        await supabase
          .from("real_estate_units")
          .update({ status: "vendido" })
          .in("id", unitIds);
      }
    }

    setActionLoading(null);
    toast.success(`Separación ${STATUS_LABEL[status].toLowerCase()}`);
    onChanged();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle className="text-popover-foreground">
                {reservation.contact?.name || reservation.contact?.phone || "Cliente"}
              </SheetTitle>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium",
                  STATUS_BADGE[reservation.status],
                )}
              >
                {STATUS_LABEL[reservation.status]}
              </span>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            <div className="rounded-lg border border-border bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">Monto total</p>
              <p className="text-xl font-bold text-foreground">
                {formatCurrency(reservation.total_amount, reservation.currency)}
              </p>
            </div>

            {reservation.contact && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Cliente
                </p>
                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {reservation.contact.name || "Sin nombre"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {reservation.contact.phone}
                    </p>
                  </div>
                  <a
                    href={`https://wa.me/${reservation.contact.phone?.replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md bg-primary/10 p-2 text-primary hover:bg-primary/20"
                    title="Chatear por WhatsApp"
                  >
                    <MessageCircle className="h-4 w-4" />
                  </a>
                </div>
              </div>
            )}

            {reservation.units && reservation.units.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Unidades ({reservation.units.length})
                </p>
                <div className="space-y-2">
                  {reservation.units.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center justify-between rounded-lg border border-border p-2.5 text-sm"
                    >
                      <span className="text-foreground">{u.code}</span>
                      {u.price != null && (
                        <span className="text-muted-foreground">
                          {formatCurrency(u.price, u.currency)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {reservation.notes && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Notas
                </p>
                <p className="text-sm text-foreground">{reservation.notes}</p>
              </div>
            )}

            {/* Payments */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Pagos
                </p>
                {canAddPayment && !showPaymentForm && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowPaymentForm(true)}
                    className="h-7 text-primary hover:text-primary"
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Agregar pago
                  </Button>
                )}
              </div>

              {showPaymentForm && accountId && (
                <div className="mb-3">
                  <PaymentUpload
                    reservationId={reservation.id}
                    accountId={accountId}
                    onCancel={() => setShowPaymentForm(false)}
                    onSaved={() => {
                      setShowPaymentForm(false);
                      void loadPayments();
                    }}
                  />
                </div>
              )}

              {loadingPayments ? (
                <div className="flex items-center justify-center py-3 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Cargando...
                </div>
              ) : payments.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin pagos registrados.</p>
              ) : (
                <div className="space-y-2">
                  {payments.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between rounded-lg border border-border p-2.5 text-sm"
                    >
                      <div>
                        <p className="text-foreground">
                          {formatCurrency(p.amount, reservation.currency)}{" "}
                          <span className="text-xs text-muted-foreground">({p.type})</span>
                        </p>
                        {p.reference && (
                          <p className="text-xs text-muted-foreground">{p.reference}</p>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {PAYMENT_STATUS_LABEL[p.status] ?? p.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Approval workflow */}
          <div className="border-t border-border/50 bg-popover/80 p-4 space-y-2">
            {reservation.status === "pendiente" && (
              <div className="flex gap-2">
                <GatedButton
                  canAct={canApprove}
                  gateReason="aprobar separaciones"
                  disabled={!!actionLoading}
                  onClick={() => updateStatus("aprobada")}
                  className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {actionLoading === "aprobada" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Check className="mr-1 h-4 w-4" />
                      Aprobar
                    </>
                  )}
                </GatedButton>
                <GatedButton
                  canAct={canApprove}
                  gateReason="rechazar separaciones"
                  disabled={!!actionLoading}
                  onClick={() => updateStatus("rechazada")}
                  className="flex-1 bg-red-600 text-white hover:bg-red-700"
                >
                  {actionLoading === "rechazada" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <X className="mr-1 h-4 w-4" />
                      Rechazar
                    </>
                  )}
                </GatedButton>
              </div>
            )}
            {reservation.status === "aprobada" && (
              <GatedButton
                canAct={canApprove}
                gateReason="cerrar ventas"
                disabled={!!actionLoading}
                onClick={() => updateStatus("cerrada")}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {actionLoading === "cerrada" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Marcar venta como cerrada"
                )}
              </GatedButton>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
