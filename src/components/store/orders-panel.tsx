"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MessageCircle } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { customerWhatsappUrl, formatMoney } from "@/lib/store/format";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/store/order";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  PAYMENT_LABEL,
  SELECT_CLASS,
  SHIPPING_LABEL,
  STATUS_LABEL,
  type StoreOrder,
} from "./types";

const STATUS_TONE: Record<OrderStatus, string> = {
  nuevo: "bg-amber-500/10 text-amber-500",
  pagado: "bg-emerald-500/10 text-emerald-500",
  enviado: "bg-sky-500/10 text-sky-500",
  entregado: "bg-primary/10 text-primary",
  cancelado: "bg-rose-500/10 text-rose-500",
};

const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function OrderDetail({ o }: { o: StoreOrder }) {
  return (
    <div className="space-y-2 text-sm">
      <ul className="space-y-0.5">
        {o.items.map((it) => (
          <li key={it.product_id} className="flex justify-between gap-3">
            <span>
              {it.quantity} × {it.name}
            </span>
            <span className="text-muted-foreground">{formatMoney(it.subtotal, o.currency)}</span>
          </li>
        ))}
      </ul>
      <p>
        <span className="text-muted-foreground">Envío:</span> {SHIPPING_LABEL[o.shipping_method] ?? o.shipping_method} ·{" "}
        {o.address}, {o.city}, {o.country}
      </p>
      {(o.customer_email || o.customer_document) && (
        <p className="text-muted-foreground">
          {[o.customer_email, o.customer_document && "Doc. " + o.customer_document].filter(Boolean).join(" · ")}
        </p>
      )}
      {o.notes && (
        <p>
          <span className="text-muted-foreground">Notas:</span> {o.notes}
        </p>
      )}
      {o.source && <p className="text-muted-foreground">Origen: {o.source}</p>}
    </div>
  );
}

function WhatsAppButton({ phone }: { phone: string }) {
  const url = customerWhatsappUrl(phone);
  if (!url) return <span className="text-sm">{phone}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm text-emerald-500 hover:underline"
    >
      <MessageCircle className="h-4 w-4" /> {phone}
    </a>
  );
}

export function OrdersPanel({
  orders,
  canWrite,
  onChanged,
}: {
  orders: StoreOrder[];
  canWrite: boolean;
  onChanged: (id: string, status: OrderStatus) => void;
}) {
  const [filter, setFilter] = useState<OrderStatus | "todos">("todos");
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const shown = useMemo(() => (filter === "todos" ? orders : orders.filter((o) => o.status === filter)), [orders, filter]);

  async function changeStatus(o: StoreOrder, status: OrderStatus) {
    if (status === o.status) return;
    setSaving(o.id);
    const { error } = await createClient().from("store_orders").update({ status }).eq("id", o.id);
    setSaving(null);
    if (error) {
      toast.error("No se pudo cambiar el estado: " + error.message);
      return;
    }
    onChanged(o.id, status);
    toast.success(o.code + ": " + STATUS_LABEL[status]);
  }

  const statusSelect = (o: StoreOrder) => (
    <select
      aria-label={"Estado de " + o.code}
      className={SELECT_CLASS}
      value={o.status}
      disabled={!canWrite || saving === o.id}
      onChange={(e) => changeStatus(o, e.target.value as OrderStatus)}
    >
      {ORDER_STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="text-sm text-muted-foreground" htmlFor="store-filter">
          Estado
        </label>
        <select
          id="store-filter"
          className={SELECT_CLASS}
          value={filter}
          onChange={(e) => setFilter(e.target.value as OrderStatus | "todos")}
        >
          <option value="todos">Todos</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">{shown.length} pedidos</span>
      </div>

      {shown.length === 0 && (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Todavía no hay pedidos {filter !== "todos" ? "con este estado" : ""}.
        </p>
      )}

      {/* Escritorio: tabla */}
      {shown.length > 0 && (
        <div className="hidden md:block rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>Código</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Teléfono</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Pago</TableHead>
                <TableHead>Envío</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((o) => (
                <Fragment key={o.id}>
                  <TableRow>
                    <TableCell>
                      <button
                        type="button"
                        aria-label="Ver detalle"
                        onClick={() => setOpen(open === o.id ? null : o.id)}
                        className="text-muted-foreground"
                      >
                        {open === o.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </TableCell>
                    <TableCell className="font-medium">{o.code}</TableCell>
                    <TableCell>{fechaCorta(o.created_at)}</TableCell>
                    <TableCell>{o.customer_name}</TableCell>
                    <TableCell>
                      <WhatsAppButton phone={o.customer_phone} />
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(o.total, o.currency)}</TableCell>
                    <TableCell>{PAYMENT_LABEL[o.payment_method] ?? o.payment_method}</TableCell>
                    <TableCell>{SHIPPING_LABEL[o.shipping_method] ?? o.shipping_method}</TableCell>
                    <TableCell>{statusSelect(o)}</TableCell>
                  </TableRow>
                  {open === o.id && (
                    <TableRow>
                      <TableCell />
                      <TableCell colSpan={8} className="whitespace-normal bg-muted/30">
                        <OrderDetail o={o} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Celular: tarjetas */}
      <div className="space-y-3 md:hidden">
        {shown.map((o) => (
          <div key={o.id} className="space-y-2 rounded-xl border p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{o.code}</p>
                <p className="text-xs text-muted-foreground">{fechaCorta(o.created_at)}</p>
              </div>
              <Badge className={cn("border-0", STATUS_TONE[o.status])}>{STATUS_LABEL[o.status]}</Badge>
            </div>
            <p className="text-sm font-medium">{o.customer_name}</p>
            <WhatsAppButton phone={o.customer_phone} />
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {PAYMENT_LABEL[o.payment_method] ?? o.payment_method} · {SHIPPING_LABEL[o.shipping_method] ?? o.shipping_method}
              </span>
              <span className="font-semibold">{formatMoney(o.total, o.currency)}</span>
            </div>
            {open === o.id && <OrderDetail o={o} />}
            <div className="flex items-center justify-between gap-2">
              <button type="button" className="text-sm text-primary" onClick={() => setOpen(open === o.id ? null : o.id)}>
                {open === o.id ? "Ocultar detalle" : "Ver detalle"}
              </button>
              {statusSelect(o)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
