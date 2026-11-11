"use client";

// ============================================================
// /store — Tienda: pedidos que llegan de la tienda web, productos y
// ajustes de pago/envío. Lee y escribe con la sesión (RLS, migración 087).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ShoppingBag } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatMoney } from "@/lib/store/format";
import { summarizeSales, type OrderStatus } from "@/lib/store/order";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OrdersPanel } from "@/components/store/orders-panel";
import { ProductsPanel } from "@/components/store/products-panel";
import { SettingsPanel } from "@/components/store/settings-panel";
import type { StoreOrder, StoreProduct, StoreSettingsRow } from "@/components/store/types";

const ORDERS_LIMIT = 500;

export default function StorePage() {
  const { accountId, moduleAccess } = useAuth();
  const canWrite = moduleAccess?.tienda !== false;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [settings, setSettings] = useState<StoreSettingsRow | null>(null);
  const [tab, setTab] = useState("pedidos");

  const load = useCallback(async () => {
    if (!accountId) return;
    const db = createClient();
    const [o, p, s] = await Promise.all([
      db.from("store_orders").select("*").eq("account_id", accountId).order("created_at", { ascending: false }).limit(ORDERS_LIMIT),
      db.from("store_products").select("*").eq("account_id", accountId).order("sort").order("created_at"),
      db.from("store_settings").select("*").eq("account_id", accountId).maybeSingle(),
    ]);
    const err = o.error ?? p.error ?? s.error;
    if (err) {
      setError(err.message);
    } else {
      setError(null);
      setOrders(((o.data ?? []) as StoreOrder[]).map((x) => ({ ...x, total: Number(x.total) })));
      setProducts(((p.data ?? []) as StoreProduct[]).map((x) => ({ ...x, price: Number(x.price) })));
      setSettings((s.data as StoreSettingsRow | null) ?? null);
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const currency = settings?.currency ?? "PEN";
  const sales = useMemo(() => summarizeSales(orders), [orders]);

  function patchStatus(id: string, status: OrderStatus) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <ShoppingBag className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Tienda</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
          No se pudo cargar la tienda: {error}. Si la migración 087 no está aplicada, pídesela a soporte.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Summary label="Ventas de hoy" value={formatMoney(sales.today, currency)} />
            <Summary label="Ventas del mes" value={formatMoney(sales.month, currency)} />
            <Summary label="Pedidos nuevos por atender" value={String(sales.pendingNew)} highlight={sales.pendingNew > 0} />
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
            <TabsList>
              <TabsTrigger value="pedidos">Pedidos</TabsTrigger>
              <TabsTrigger value="productos">Productos</TabsTrigger>
              <TabsTrigger value="ajustes">Ajustes</TabsTrigger>
            </TabsList>
            <TabsContent value="pedidos" className="pt-4">
              <OrdersPanel orders={orders} canWrite={canWrite} onChanged={patchStatus} />
            </TabsContent>
            <TabsContent value="productos" className="pt-4">
              {accountId && (
                <ProductsPanel accountId={accountId} products={products} currency={currency} canWrite={canWrite} onReload={load} />
              )}
            </TabsContent>
            <TabsContent value="ajustes" className="pt-4">
              {accountId && (
                <SettingsPanel
                  key={settings ? "con-ajustes" : "sin-ajustes"}
                  accountId={accountId}
                  settings={settings}
                  canWrite={canWrite}
                  onSaved={load}
                />
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function Summary({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={"mt-1 text-2xl font-bold " + (highlight ? "text-amber-500" : "text-foreground")}>{value}</p>
    </div>
  );
}
