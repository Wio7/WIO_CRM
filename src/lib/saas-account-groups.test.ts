import { describe, expect, it } from "vitest";
import { groupAccountsByBusiness, knownApps, type SaasAccount } from "./saas-account-groups";

const acc = (id: string, name: string): SaasAccount => ({
  id,
  name,
  status: "active",
  created_at: "2026-10-14T00:00:00Z",
  default_currency: "USD",
});

const accounts = [
  acc("julio", "Julio Palli"),
  acc("paula", "paulauribegoldenhabitat@gmail.com"),
  acc("legal", "legal.goldenhabitat@gmail.com"),
  acc("area", "arealegaldreamhabitat@gmail.com"),
  acc("asist", "asistentelegalgh@gmail.com"),
  acc("christian", "Christian Linares"),
  acc("aurex", "Aurex"),
  acc("golden", "Golden Habitat"),
];

describe("agrupar cuentas por negocio", () => {
  const groups = groupAccountsByBusiness(accounts);

  it("deja un grupo por negocio, en orden fijo", () => {
    expect(groups.map((g) => g.name)).toEqual([
      "Golden Habitat",
      "Broker Home",
      "Juris Pro",
      "Aurex",
    ]);
  });

  it("mete los correos del personal dentro de Golden Habitat", () => {
    const golden = groups[0];
    expect(golden.primary.id).toBe("golden");
    expect(golden.members.map((m) => m.id).sort()).toEqual(["area", "asist", "legal", "paula"]);
    expect(golden.apps).toEqual(["Golden App (ventas)", "Golden Caja", "Golden Legal"]);
  });

  it("Julio Palli es Broker Home, Christian Linares es Juris Pro", () => {
    expect(groups[1].primary.id).toBe("julio");
    expect(groups[2].primary.id).toBe("christian");
    expect(groups[1].members).toEqual([]);
  });

  it("una cuenta desconocida queda como su propio negocio", () => {
    const [extra] = groupAccountsByBusiness([acc("x", "Otra Empresa")]);
    expect(extra).toMatchObject({ name: "Otra Empresa", members: [] });
  });

  it("si solo existen los correos, el primero hace de cuenta principal", () => {
    const [g] = groupAccountsByBusiness([acc("a", "legal.goldenhabitat@gmail.com")]);
    expect(g.name).toBe("Golden Habitat");
    expect(g.primary.id).toBe("a");
  });

  it("sin la migración, José Chipana cae dentro de Juris Pro detrás de Christian", () => {
    const list = [
      { ...acc("jose", "José Chipana"), created_at: "2026-10-25T00:00:00Z" },
      { ...acc("christian", "Christian Linares"), created_at: "2026-10-12T00:00:00Z" },
    ];
    const [juris] = groupAccountsByBusiness(list);
    expect(juris.name).toBe("Juris Pro");
    expect(juris.primary.id).toBe("christian");
    expect(juris.members.map((m) => m.id)).toEqual(["jose"]);
    expect(juris.apps).toEqual(["Juris Pro App"]);
  });
});

describe("agrupar con la migración 081 (negocio guardado en la base)", () => {
  const withCols = (id: string, name: string, parent: string | null, apps: string[] = []): SaasAccount => ({
    ...acc(id, name),
    parent_account_id: parent,
    apps,
  });

  const list = [
    withCols("xdel", "XDEL Barbershop", null, ["Barberia"]),
    withCols("jose", "José Chipana", "christian", ["Juris Pro App"]),
    withCols("legal", "legal.goldenhabitat@gmail.com", "golden", ["Golden Legal"]),
    withCols("christian", "Christian Linares", null, ["Juris Pro App"]),
    withCols("golden", "Golden Habitat", null, ["Golden App (ventas)", "Golden Legal"]),
    withCols("huerfana", "Cuenta suelta", "no-existe"),
  ];
  const groups = groupAccountsByBusiness(list);

  it("solo los negocios quedan arriba, primero los conocidos", () => {
    expect(groups.map((g) => g.primary.id)).toEqual(["golden", "christian", "xdel", "huerfana"]);
  });

  it("cada cuenta cuelga del negocio guardado, con sus apps", () => {
    expect(groups[0].members.map((m) => m.id)).toEqual(["legal"]);
    expect(groups[0].apps).toEqual(["Golden App (ventas)", "Golden Legal"]);
    expect(groups[1].name).toBe("Juris Pro");
    expect(groups[1].members.map((m) => m.id)).toEqual(["jose"]);
    expect(groups[2]).toMatchObject({ name: "XDEL Barbershop", apps: ["Barberia"], members: [] });
  });

  it("lo guardado manda sobre el nombre", () => {
    const moved = groupAccountsByBusiness([
      withCols("golden", "Golden Habitat", null),
      withCols("x", "golden.algo@gmail.com", null),
    ]);
    expect(moved).toHaveLength(2);
  });

  it("knownApps junta las apps sin repetir", () => {
    expect(knownApps(list)).toContain("Barberia");
    expect(knownApps(list).filter((a) => a === "Juris Pro App")).toHaveLength(1);
  });
});
