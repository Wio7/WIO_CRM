import { describe, expect, it } from "vitest";
import { CUENTA_WIO_ID, nombreVisible } from "./cuenta-wio";
import { groupAccountsByBusiness } from "./saas-account-groups";

const acc = (id: string, name: string, extra = {}) => ({ id, name, status: "active", created_at: "", default_currency: "USD", ...extra });

describe("cuenta Wio Suite", () => {
  it("solo cambia el nombre visible de esa cuenta", () => {
    expect(nombreVisible({ id: CUENTA_WIO_ID, name: "Aurex" })).toBe("Wio Suite");
    expect(nombreVisible({ id: "otra", name: "Aurex Vital Control" })).toBe("Aurex Vital Control");
  });
  it("la lista de agencia la muestra como Wio Suite, con y sin la 081", () => {
    expect(groupAccountsByBusiness([acc(CUENTA_WIO_ID, "Aurex")])[0].name).toBe("Wio Suite");
    expect(groupAccountsByBusiness([acc(CUENTA_WIO_ID, "Aurex", { parent_account_id: null })])[0].name).toBe("Wio Suite");
  });
});
