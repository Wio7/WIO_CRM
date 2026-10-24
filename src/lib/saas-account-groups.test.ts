import { describe, expect, it } from "vitest";
import { groupAccountsByBusiness, type SaasAccount } from "./saas-account-groups";

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
});
