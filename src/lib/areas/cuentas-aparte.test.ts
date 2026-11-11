import { describe, expect, it } from "vitest";
import { separarCuentasAparte } from "./cuentas-aparte";

const persona = (id: string, email: string | null) => ({ id, email });
const hija = (id: string, name: string) => ({ id, name });

describe("separarCuentasAparte", () => {
  it("una cuenta hija con el correo de una persona se ata a ella y sale de Otras cuentas", () => {
    const r = separarCuentasAparte(
      [persona("p1", "legal.goldenhabitat@gmail.com"), persona("p2", "sara@x.com")],
      [hija("c1", "legal.goldenhabitat@gmail.com"), hija("c2", "Otro negocio")],
    );
    expect(r.porPersona.get("p1")).toEqual({ id: "c1", name: "legal.goldenhabitat@gmail.com" });
    expect(r.porPersona.has("p2")).toBe(false);
    expect(r.otras.map((c) => c.id)).toEqual(["c2"]);
  });

  it("no distingue mayusculas ni espacios en los bordes", () => {
    const r = separarCuentasAparte([persona("p1", "Legal@Gh.com")], [hija("c1", " legal@gh.COM ")]);
    expect(r.porPersona.get("p1")?.id).toBe("c1");
    expect(r.otras).toEqual([]);
  });

  it("las que no coinciden siguen en Otras cuentas; sin correo no se empareja nada", () => {
    const r = separarCuentasAparte([persona("p1", null), persona("p2", "")], [hija("c1", "algo@x.com"), hija("c2", "")]);
    expect(r.porPersona.size).toBe(0);
    expect(r.otras.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("si dos cuentas coinciden con la misma persona, la primera se ata y la otra queda en Otras", () => {
    const r = separarCuentasAparte([persona("p1", "a@x.com")], [hija("c1", "a@x.com"), hija("c2", "A@x.com")]);
    expect(r.porPersona.get("p1")?.id).toBe("c1");
    expect(r.otras.map((c) => c.id)).toEqual(["c2"]);
  });

  it("conserva los campos extra de la cuenta", () => {
    const r = separarCuentasAparte([persona("p1", "a@x.com")], [{ id: "c1", name: "a@x.com", status: "active" }]);
    expect(r.porPersona.get("p1")).toMatchObject({ status: "active" });
  });
});
