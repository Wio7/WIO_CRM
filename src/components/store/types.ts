import type { OrderStatus } from "@/lib/store/order";

export interface OrderItem {
  product_id: string;
  name: string;
  unit_price: number;
  quantity: number;
  subtotal: number;
}

export interface StoreOrder {
  id: string;
  code: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  customer_document: string | null;
  shipping_method: string;
  country: string;
  city: string;
  address: string;
  payment_method: string;
  status: OrderStatus;
  items: OrderItem[];
  total: number;
  currency: string;
  notes: string | null;
  source: string | null;
  created_at: string;
}

export interface StoreProduct {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  price: number;
  currency: string;
  image_url: string | null;
  includes: string[];
  badge: string | null;
  active: boolean;
  sort: number;
}

export interface StoreSettingsRow {
  enabled: boolean;
  whatsapp: string | null;
  yape_number: string | null;
  yape_holder: string | null;
  mercadopago_holder: string | null;
  mercadopago_link: string | null;
  shipping_note: string | null;
  currency: string;
}

export const SELECT_CLASS =
  "h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

export const STATUS_LABEL: Record<OrderStatus, string> = {
  nuevo: "Nuevo",
  pagado: "Pagado",
  enviado: "Enviado",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

export const SHIPPING_LABEL: Record<string, string> = {
  shalom: "Shalom",
  olva: "Olva Courier",
  marvisur: "Marvisur",
  internacional: "Internacional",
  recojo: "Recojo",
};

export const PAYMENT_LABEL: Record<string, string> = {
  yape: "Yape",
  mercadopago: "Mercado Pago",
  whatsapp: "WhatsApp",
};
