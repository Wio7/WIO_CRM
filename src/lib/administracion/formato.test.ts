import { describe, expect, it } from "vitest";

import { fechaHoraLima, mesActualLima, nombreMes, rangoMes, sumarDias, sumarMes } from "./formato";

describe("formato de la app de Administración", () => {
  it("fechaHoraLima pasa de UTC (o de cualquier zona) a la hora de Lima", () => {
    expect(fechaHoraLima("2026-10-01T12:11:20+00:00")).toBe("01/10/2026 07:11");
    expect(fechaHoraLima("2026-10-01T07:11:20-05:00")).toBe("01/10/2026 07:11");
    expect(fechaHoraLima("2026-10-02T03:30:00+00:00")).toBe("01/10/2026 22:30");
    expect(fechaHoraLima("basura")).toBe("—");
  });
  it("nombreMes", () => {
    expect(nombreMes("2026-10")).toBe("octubre de 2026");
    expect(nombreMes("2027-01")).toBe("enero de 2027");
    expect(nombreMes("x")).toBe("x");
  });
  it("mesActualLima usa el día de Lima", () => {
    expect(mesActualLima(new Date("2026-11-01T03:00:00Z"))).toBe("2026-10"); // 22:00 del 31/10 en Lima
    expect(mesActualLima(new Date("2026-11-01T06:00:00Z"))).toBe("2026-11");
  });
  it("sumarMes cruza años", () => {
    expect(sumarMes("2026-12", 1)).toBe("2027-01");
    expect(sumarMes("2026-01", -1)).toBe("2025-12");
    expect(sumarMes("2026-10", 0)).toBe("2026-10");
  });
  it("rangoMes y sumarDias", () => {
    expect(rangoMes("2026-10")).toEqual({ desde: "2026-10-01", hasta: "2026-10-31" });
    expect(rangoMes("2028-02")).toEqual({ desde: "2028-02-01", hasta: "2028-02-29" });
    expect(sumarDias("2026-10-31", 1)).toBe("2026-11-01");
    expect(sumarDias("2026-01-01", -1)).toBe("2025-12-31");
  });
});
