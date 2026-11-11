import { describe, expect, it } from "vitest";

import { textoDelBorrador, type Borrador } from "./texto";

const base: Borrador = {
  caja: "Restaurante",
  kind: "expense",
  amountCents: 4000,
  concept: "Gasolina combi",
  paymentMethod: "cash",
  category: null,
  justification: null,
};

describe("borrador por WhatsApp: rubro y proyecto", () => {
  it("muestra lo propuesto", () => {
    const t = textoDelBorrador({ ...base, rubro: "combi", proyecto: "Blue Village" });
    expect(t).toContain("Rubro: Combi · Proyecto: Blue Village");
  });
  it("lo que no se dedujo queda sin asignar", () => {
    expect(textoDelBorrador(base)).toContain("Rubro: sin asignar · Proyecto: sin asignar");
  });
  it("un ingreso no muestra rubro ni proyecto", () => {
    expect(textoDelBorrador({ ...base, kind: "income" })).not.toContain("Rubro:");
  });
});
