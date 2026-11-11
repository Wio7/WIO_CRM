import { describe, expect, it } from "vitest";

import { parseOrderBody, summarizeSales, parseIncludes, type StoreOrderRow } from "./order";

const P1 = "7b0f3c1e-5a52-4f7e-9d3c-2b1a8f0e6c11";
const P2 = "0c9d1e22-84b6-4c53-a1f0-6e3f7a2b9d44";

function valid() {
  return {
    customer: { name: "Ana Perez", phone: "+51 999 111 222" },
    shipping: { method: "shalom", city: "Ica", address: "Av. Grau 123" },
    payment_method: "yape",
    items: [{ product_id: P1, quantity: 2 }],
  };
}

describe("parseOrderBody", () => {
  it("acepta un pedido minimo y aplica los valores por defecto", () => {
    const r = parseOrderBody(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.shipping.country).toBe("Peru");
    expect(r.value.customer.email).toBeNull();
    expect(r.value.notes).toBeNull();
    expect(r.value.source).toBeNull();
    expect(r.value.items).toEqual([{ product_id: P1, quantity: 2 }]);
  });

  it("junta los productos repetidos sumando la cantidad", () => {
    const b = valid();
    b.items = [
      { product_id: P1, quantity: 1 },
      { product_id: P2, quantity: 3 },
      { product_id: P1, quantity: 2 },
    ];
    const r = parseOrderBody(b);
    expect(r.ok && r.value.items).toEqual([
      { product_id: P1, quantity: 3 },
      { product_id: P2, quantity: 3 },
    ]);
  });

  it.each([
    ["no es un objeto", null, "cuerpo"],
    ["sin nombre", { ...valid(), customer: { name: " ", phone: "999" } }, "nombre"],
    ["sin telefono", { ...valid(), customer: { name: "Ana" } }, "telefono"],
    ["metodo de envio desconocido", { ...valid(), shipping: { method: "dhl", city: "Ica", address: "x" } }, "envio"],
    ["sin ciudad", { ...valid(), shipping: { method: "olva", address: "x" } }, "ciudad"],
    ["sin direccion", { ...valid(), shipping: { method: "olva", city: "Ica" } }, "direccion"],
    ["metodo de pago desconocido", { ...valid(), payment_method: "bitcoin" }, "pago"],
    ["sin productos", { ...valid(), items: [] }, "producto"],
    ["id de producto invalido", { ...valid(), items: [{ product_id: "abc", quantity: 1 }] }, "producto"],
    ["cantidad cero", { ...valid(), items: [{ product_id: P1, quantity: 0 }] }, "cantidad"],
    ["cantidad mayor a 20", { ...valid(), items: [{ product_id: P1, quantity: 21 }] }, "cantidad"],
    ["cantidad decimal", { ...valid(), items: [{ product_id: P1, quantity: 1.5 }] }, "cantidad"],
    ["correo invalido", { ...valid(), customer: { name: "Ana", phone: "999111222", email: "no-es-correo" } }, "correo"],
    ["canal desconocido", { ...valid(), source: "radio" }, "origen"],
  ])("rechaza: %s", (_n, body, palabra) => {
    const r = parseOrderBody(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.toLowerCase()).toContain(palabra);
  });

  it("rechaza si la suma de un mismo producto pasa de 20", () => {
    const b = valid();
    b.items = [
      { product_id: P1, quantity: 15 },
      { product_id: P1, quantity: 10 },
    ];
    const r = parseOrderBody(b);
    expect(r.ok).toBe(false);
  });
});

describe("parseIncludes", () => {
  it("separa por lineas, recorta y quita vacias", () => {
    expect(parseIncludes("1 caja\n\n  Kolina \n")).toEqual(["1 caja", "Kolina"]);
  });
});

describe("summarizeSales", () => {
  const mk = (status: StoreOrderRow["status"], total: number, created_at: string): StoreOrderRow => ({
    id: created_at + status, status, total, created_at,
  });
  // 2026-11-10 15:00 en Lima = 20:00 UTC
  const now = new Date("2026-11-10T20:00:00Z");

  it("suma hoy y mes solo de pagado/enviado/entregado, en dia de Lima", () => {
    const orders = [
      mk("pagado", 269, "2026-11-10T19:00:00Z"),
      mk("enviado", 529, "2026-11-03T15:00:00Z"),
      mk("nuevo", 759, "2026-11-10T18:00:00Z"),
      mk("cancelado", 100, "2026-11-10T18:00:00Z"),
      mk("entregado", 50, "2026-10-31T12:00:00Z"),
      // 2026-11-11 03:00 UTC = 10 nov 22:00 Lima -> cuenta como hoy
      mk("pagado", 10, "2026-11-11T03:00:00Z"),
      // 2026-11-01 02:00 UTC = 31 oct 21:00 Lima -> mes anterior
      mk("pagado", 1000, "2026-11-01T02:00:00Z"),
    ];
    expect(summarizeSales(orders, now)).toEqual({ today: 279, month: 808, pendingNew: 1 });
  });
});
