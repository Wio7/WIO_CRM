import { describe, expect, it } from "vitest";
import { areaDeInvitacion, estadoInvitacion } from "./invitacion";

describe("areaDeInvitacion", () => {
  it("sin área es una invitación normal", () => {
    for (const role of ["owner", "admin", "agent", "viewer"] as const) {
      expect(areaDeInvitacion(undefined, role)).toEqual({ ok: true, area: null });
      expect(areaDeInvitacion(null, role)).toEqual({ ok: true, area: null });
      expect(areaDeInvitacion("", role)).toEqual({ ok: true, area: null });
    }
  });

  it("promueve solo va con el rol agent", () => {
    expect(areaDeInvitacion("promueve", "agent")).toEqual({ ok: true, area: "promueve" });
    for (const role of ["owner", "admin", "viewer"] as const) {
      const r = areaDeInvitacion("promueve", role);
      expect(r.ok).toBe(false);
    }
  });

  it("rechaza cualquier otra área o un valor que no es texto", () => {
    expect(areaDeInvitacion("legal", "agent").ok).toBe(false);
    expect(areaDeInvitacion("PROMUEVE", "agent").ok).toBe(false);
    expect(areaDeInvitacion(5, "agent").ok).toBe(false);
    expect(areaDeInvitacion({}, "agent").ok).toBe(false);
  });
});

describe("estadoInvitacion", () => {
  const ahora = new Date("2026-11-11T12:00:00Z");
  it("pendiente, aceptada y vencida", () => {
    expect(estadoInvitacion({ accepted_at: null, expires_at: "2026-11-12T00:00:00Z" }, ahora)).toBe("pendiente");
    expect(estadoInvitacion({ accepted_at: null, expires_at: "2026-11-10T00:00:00Z" }, ahora)).toBe("vencida");
    expect(estadoInvitacion({ accepted_at: "2026-11-09T00:00:00Z", expires_at: "2026-11-10T00:00:00Z" }, ahora)).toBe("aceptada");
  });
});
