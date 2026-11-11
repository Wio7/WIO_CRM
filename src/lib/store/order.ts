// ============================================================
// Tienda — reglas puras de pedidos (sin I/O).
//
// parseOrderBody valida el cuerpo de POST /api/v1/store/orders y lo deja
// normalizado. El total NO se calcula aquí: lo calcula la base de datos
// (store_create_order, migración 087) con los precios reales de los
// productos activos de la cuenta.
// ============================================================

export const SHIPPING_METHODS = ["shalom", "olva", "marvisur", "internacional", "recojo"] as const;
export const PAYMENT_METHODS = ["yape", "mercadopago", "whatsapp"] as const;
export const ORDER_STATUSES = ["nuevo", "pagado", "enviado", "entregado", "cancelado"] as const;
export const ORDER_SOURCES = ["tiktok", "instagram", "facebook", "link"] as const;

export type ShippingMethod = (typeof SHIPPING_METHODS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const MAX_QUANTITY = 20;

export interface OrderInput {
  customer: { name: string; phone: string; email: string | null; document: string | null };
  shipping: { method: ShippingMethod; country: string; city: string; address: string };
  payment_method: PaymentMethod;
  items: { product_id: string; quantity: number }[];
  notes: string | null;
  source: OrderSource | null;
}

export type ParseResult = { ok: true; value: OrderInput } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Texto recortado; null si no es texto o queda vacio. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

const fail = (message: string): ParseResult => ({ ok: false, message });

export function parseOrderBody(body: unknown): ParseResult {
  const b = obj(body);
  if (!b) return fail("El cuerpo debe ser un objeto JSON.");

  const c = obj(b.customer);
  const name = text(c?.name, 120);
  if (!name) return fail("Falta el nombre del cliente (customer.name).");
  const phone = text(c?.phone, 30);
  if (!phone || phone.replace(/\D/g, "").length < 6) {
    return fail("Falta un telefono valido del cliente (customer.phone).");
  }
  let email: string | null = null;
  if (c?.email !== undefined && c.email !== null && c.email !== "") {
    email = text(c.email, 160);
    if (!email || !EMAIL.test(email)) return fail("El correo del cliente no es valido (customer.email).");
  }
  const document = text(c?.document, 30);

  const s = obj(b.shipping);
  const method = oneOf(SHIPPING_METHODS, s?.method);
  if (!method) {
    return fail(`El metodo de envio no es valido (shipping.method). Opciones: ${SHIPPING_METHODS.join(", ")}.`);
  }
  const city = text(s?.city, 80);
  if (!city) return fail("Falta la ciudad de envio (shipping.city).");
  const address = text(s?.address, 240);
  if (!address) return fail("Falta la direccion de envio (shipping.address).");
  const country = text(s?.country, 60) ?? "Peru";

  const payment = oneOf(PAYMENT_METHODS, b.payment_method);
  if (!payment) {
    return fail(`El metodo de pago no es valido (payment_method). Opciones: ${PAYMENT_METHODS.join(", ")}.`);
  }

  let source: OrderSource | null = null;
  if (b.source !== undefined && b.source !== null && b.source !== "") {
    source = oneOf(ORDER_SOURCES, b.source);
    if (!source) return fail(`El origen no es valido (source). Opciones: ${ORDER_SOURCES.join(", ")}.`);
  }

  if (!Array.isArray(b.items) || b.items.length === 0) {
    return fail("Agrega al menos un producto (items).");
  }
  const merged = new Map<string, number>();
  for (const raw of b.items) {
    const it = obj(raw);
    const id = typeof it?.product_id === "string" ? it.product_id.toLowerCase() : "";
    if (!UUID.test(id)) return fail("Hay un producto con id invalido (items[].product_id).");
    const q = it?.quantity;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) {
      return fail(`La cantidad de cada producto debe ser un numero entero de 1 a ${MAX_QUANTITY} (items[].quantity).`);
    }
    const total = (merged.get(id) ?? 0) + q;
    if (total > MAX_QUANTITY) {
      return fail(`La cantidad de un mismo producto no puede pasar de ${MAX_QUANTITY}.`);
    }
    merged.set(id, total);
  }

  return {
    ok: true,
    value: {
      customer: { name, phone, email, document },
      shipping: { method, country, city, address },
      payment_method: payment,
      items: [...merged].map(([product_id, quantity]) => ({ product_id, quantity })),
      notes: text(b.notes, 500),
      source,
    },
  };
}

/** "Que incluye": una linea por item; sin lineas vacias. */
export function parseIncludes(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------- Resumen del panel ----------

export interface StoreOrderRow {
  id: string;
  status: OrderStatus;
  total: number;
  created_at: string;
}

const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000; // Lima = UTC-5, sin horario de verano

function limaDay(t: Date | string): string {
  return new Date(new Date(t).getTime() - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

const PAID: readonly OrderStatus[] = ["pagado", "enviado", "entregado"];

/** Ventas de hoy y del mes (dia de Lima, solo pedidos pagados) y pedidos nuevos sin atender. */
export function summarizeSales(orders: readonly StoreOrderRow[], now: Date = new Date()) {
  const day = limaDay(now);
  const month = day.slice(0, 7);
  let today = 0;
  let monthTotal = 0;
  let pendingNew = 0;
  for (const o of orders) {
    if (o.status === "nuevo") pendingNew += 1;
    if (!PAID.includes(o.status)) continue;
    const d = limaDay(o.created_at);
    if (d === day) today += Number(o.total);
    if (d.startsWith(month)) monthTotal += Number(o.total);
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return { today: r(today), month: r(monthTotal), pendingNew };
}
