// Ayudas puras del panel de la Tienda (formularios, dinero, WhatsApp).

import { parseIncludes } from "./order";

/** Precio escrito por una persona: "269", "529.50" o "529,50". null si no es valido. */
export function parsePrice(raw: string): number | null {
  const t = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}

export interface ProductForm {
  name: string;
  subtitle: string;
  description: string;
  price: string;
  includes: string;
  badge: string;
  sort: string;
  image_url: string;
  active: boolean;
}

export interface ProductRow {
  name: string;
  subtitle: string | null;
  description: string | null;
  price: number;
  includes: string[];
  badge: string | null;
  sort: number;
  image_url: string | null;
  active: boolean;
}

const orNull = (s: string) => s.trim() || null;

export function buildProductRow(
  f: ProductForm,
): { ok: true; row: ProductRow } | { ok: false; message: string } {
  const name = f.name.trim();
  if (!name) return { ok: false, message: "Escribe el nombre del producto." };
  const price = parsePrice(f.price);
  if (price === null) return { ok: false, message: "El precio no es valido." };
  const sort = Number.parseInt(f.sort, 10);
  return {
    ok: true,
    row: {
      name,
      subtitle: orNull(f.subtitle),
      description: orNull(f.description),
      price,
      includes: parseIncludes(f.includes),
      badge: orNull(f.badge),
      sort: Number.isFinite(sort) ? sort : 0,
      image_url: orNull(f.image_url),
      active: f.active,
    },
  };
}

/** Dinero con 2 decimales solo si hacen falta (S/ 269 o S/ 529.50). */
export function formatMoney(value: number, currency = "PEN"): string {
  const n = Number(value) || 0;
  const decimals = Number.isInteger(n) ? 0 : 2;
  try {
    return new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency: currency || "PEN",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(decimals)}`;
  }
}

/** wa.me del cliente: celular peruano de 9 digitos (+51) o numero con codigo de pais. */
export function customerWhatsappUrl(phone: string): string | null {
  const digits = phone.replace(/\D/g, "").replace(/^00/, "");
  if (digits.length === 9 && digits.startsWith("9")) return `https://wa.me/51${digits}`;
  if (digits.length >= 11) return `https://wa.me/${digits}`;
  return null;
}
