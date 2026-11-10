// ============================================================
// Tienda — acceso a datos de la API publica (cliente de servicio).
// Todo se filtra por el account_id de la API key; nunca por algo que
// mande quien llama.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { OrderInput } from "./order";

export interface CatalogStore {
  name: string;
  logo_url: string | null;
  whatsapp: string | null;
  yape_number: string | null;
  yape_holder: string | null;
  mercadopago_holder: string | null;
  mercadopago_link: string | null;
  shipping_note: string | null;
  currency: string;
  enabled: boolean;
}

export interface CatalogProduct {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  price: number;
  currency: string;
  image_url: string | null;
  includes: string[];
  badge: string | null;
  sort: number;
}

export async function loadCatalog(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ store: CatalogStore; products: CatalogProduct[] }> {
  const [account, settings, products] = await Promise.all([
    supabase.from("accounts").select("name, brand_name, logo_url").eq("id", accountId).maybeSingle(),
    supabase
      .from("store_settings")
      .select("enabled, whatsapp, yape_number, yape_holder, mercadopago_holder, mercadopago_link, shipping_note, currency")
      .eq("account_id", accountId)
      .maybeSingle(),
    supabase
      .from("store_products")
      .select("id, name, subtitle, description, price, currency, image_url, includes, badge, sort")
      .eq("account_id", accountId)
      .eq("active", true)
      .order("sort", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);
  if (account.error) throw account.error;
  if (settings.error) throw settings.error;
  if (products.error) throw products.error;

  const a = account.data as { name: string | null; brand_name: string | null; logo_url: string | null } | null;
  const s = settings.data as Omit<CatalogStore, "name" | "logo_url"> | null;

  return {
    store: {
      name: a?.brand_name?.trim() || a?.name || "",
      logo_url: a?.logo_url?.trim() || null,
      whatsapp: s?.whatsapp ?? null,
      yape_number: s?.yape_number ?? null,
      yape_holder: s?.yape_holder ?? null,
      mercadopago_holder: s?.mercadopago_holder ?? null,
      mercadopago_link: s?.mercadopago_link ?? null,
      shipping_note: s?.shipping_note ?? null,
      currency: s?.currency ?? "PEN",
      // Sin fila de ajustes la tienda no esta configurada: apagada.
      enabled: s?.enabled ?? false,
    },
    products: ((products.data ?? []) as (Omit<CatalogProduct, "price"> & { price: number | string })[]).map((p) => ({
      id: p.id,
      name: p.name,
      subtitle: p.subtitle,
      description: p.description,
      price: Number(p.price),
      currency: p.currency,
      image_url: p.image_url,
      includes: p.includes ?? [],
      badge: p.badge,
      sort: p.sort,
    })),
  };
}

export interface CreatedOrder {
  id: string;
  code: string;
  total: number;
  currency: string;
  status: string;
  items: unknown[];
}

export type CreateOrderResult =
  | { ok: true; order: CreatedOrder }
  | { ok: false; status: number; code: string; message: string };

/**
 * Crea el pedido con store_create_order (migracion 087): la base vuelve a
 * leer los precios y calcula el total. Los errores de validacion de la
 * funcion (22023) y de tienda apagada (55000) se traducen; el resto sube.
 */
export async function createStoreOrder(
  supabase: SupabaseClient,
  accountId: string,
  input: OrderInput,
): Promise<CreateOrderResult> {
  const { data, error } = await supabase.rpc("store_create_order", {
    p_account_id: accountId,
    payload: input,
  });
  if (error) {
    if (error.code === "22023") return { ok: false, status: 400, code: "bad_request", message: error.message };
    if (error.code === "55000") return { ok: false, status: 409, code: "store_disabled", message: error.message };
    throw error;
  }
  return { ok: true, order: data as CreatedOrder };
}
