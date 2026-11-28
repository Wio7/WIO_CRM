import { describe, expect, it } from "vitest";

import {
  agruparPendientes,
  destinatariosGerencia,
  esUuidAbono,
  esperaTexto,
  inicioDiaLima,
  solicitudReciente,
  textoAvisoAbono,
  textoAbonosPendientes,
} from "./aviso-abono";

describe("destinatariosGerencia", () => {
  it("avisa a los dueños y a gerencia, nunca a solo lectura ni a otras áreas", () => {
    const ids = destinatariosGerencia([
      { user_id: "dueno", account_role: "owner", area: null },
      { user_id: "ger", account_role: "agent", area: "gerencia" },
      { user_id: "ger-lectura", account_role: "viewer", area: "gerencia" },
      { user_id: "cob", account_role: "agent", area: "cobranzas" },
    ]);
    expect(ids).toEqual(["dueno", "ger"]);
  });
  it("no le avisa a quien mandó el abono", () => {
    expect(destinatariosGerencia([{ user_id: "dueno", account_role: "owner", area: null }], "dueno")).toEqual([]);
  });
});

describe("textoAvisoAbono", () => {
  it("arma cliente, proyecto, lote, monto y quién lo manda", () => {
    expect(
      textoAvisoAbono({
        resumen: { cliente: "Ana Ruiz", proyecto: "Colinas 2", unidad: "H-26", monto_centimos: 120050, moneda: "PEN" },
        solicitado_por_nombre: "Sthefany",
      }),
    ).toEqual({ title: "Abono por validar", body: "Ana Ruiz · Colinas 2 H-26 · S/ 1,200.50 (de Sthefany)" });
  });
  it("aguanta un resumen incompleto o en dólares", () => {
    expect(textoAvisoAbono({ resumen: { monto_centimos: 5000, moneda: "USD" }, solicitado_por_nombre: null }).body).toBe("US$ 50.00");
    expect(textoAvisoAbono({ resumen: null, solicitado_por_nombre: "Cintia" }).body).toBe("Nuevo abono (de Cintia)");
  });
});

describe("solicitudReciente", () => {
  const ahora = new Date("2026-11-28T15:00:00Z");
  it("solo avisa de abonos creados hace menos de 10 minutos", () => {
    expect(solicitudReciente("2026-11-28T14:55:00Z", ahora)).toBe(true);
    expect(solicitudReciente("2026-11-28T14:49:00Z", ahora)).toBe(false);
    expect(solicitudReciente("fecha rota", ahora)).toBe(false);
  });
});

describe("inicioDiaLima", () => {
  it("es la medianoche de Lima (05:00 UTC) del día en curso en Lima", () => {
    expect(inicioDiaLima(new Date("2026-11-28T22:00:00Z")).toISOString()).toBe("2026-11-28T05:00:00.000Z");
    // 02:00 UTC del 29 todavía es el 28 en Lima.
    expect(inicioDiaLima(new Date("2026-11-29T02:00:00Z")).toISOString()).toBe("2026-11-28T05:00:00.000Z");
  });
});

describe("esperaTexto y textoAbonosPendientes", () => {
  const ahora = new Date("2026-11-28T22:00:00Z");
  it("dice cuánto espera el más antiguo", () => {
    expect(esperaTexto("2026-11-28T21:35:00Z", ahora)).toBe("25 min");
    expect(esperaTexto("2026-11-28T17:40:00Z", ahora)).toBe("4 h 20 min");
    expect(esperaTexto("2026-11-28T19:00:00Z", ahora)).toBe("3 h");
  });
  it("resume los pendientes del día", () => {
    expect(textoAbonosPendientes(1, "2026-11-28T19:00:00Z", ahora)).toEqual({
      title: "Abonos sin validar",
      body: "1 abono de hoy sigue sin validar. Espera desde hace 3 h.",
    });
    expect(textoAbonosPendientes(3, "2026-11-28T17:40:00Z", ahora).body).toBe(
      "3 abonos de hoy siguen sin validar. El más antiguo espera 4 h 20 min.",
    );
  });
});

describe("agruparPendientes y esUuidAbono", () => {
  it("cuenta por cuenta y guarda el más antiguo", () => {
    expect(
      agruparPendientes([
        { account_id: "a", created_at: "2026-11-28T18:00:00Z" },
        { account_id: "a", created_at: "2026-11-28T15:00:00Z" },
        { account_id: "b", created_at: "2026-11-28T20:00:00Z" },
      ]),
    ).toEqual([
      { account_id: "a", cantidad: 2, masAntiguo: "2026-11-28T15:00:00Z" },
      { account_id: "b", cantidad: 1, masAntiguo: "2026-11-28T20:00:00Z" },
    ]);
  });
  it("valida el id", () => {
    expect(esUuidAbono("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(esUuidAbono("1; drop")).toBe(false);
  });
});
