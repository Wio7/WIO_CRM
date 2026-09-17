import { describe, expect, it } from "vitest";

import { cleanDni, dniChange, dniErrorMessage } from "./dni";

describe("cleanDni", () => {
  it("keeps digits and drops separators", () => {
    expect(cleanDni(" 12.345.678 ")).toBe("12345678");
    expect(cleanDni("1234567")).toBeNull();
    expect(cleanDni("DNI12345678")).toBeNull();
  });
});

describe("dniChange", () => {
  it("sends nothing when the DNI didn't change", () => {
    expect(dniChange("12345678", "12 345 678")).toEqual({ patch: {} });
    expect(dniChange(null, "  ")).toEqual({ patch: {} });
    expect(dniChange(undefined, "")).toEqual({ patch: {} });
  });

  it("sets, replaces and clears", () => {
    expect(dniChange(null, "12345678")).toEqual({ patch: { dni: "12345678" } });
    expect(dniChange("12345678", "87654321")).toEqual({ patch: { dni: "87654321" } });
    expect(dniChange("12345678", "")).toEqual({ patch: { dni: null } });
  });

  it("rejects a malformed DNI", () => {
    expect(dniChange(null, "123")).toHaveProperty("error");
  });
});

describe("dniErrorMessage", () => {
  it("explains a duplicate DNI but not a duplicate phone", () => {
    expect(
      dniErrorMessage({ code: "23505", message: 'duplicate key value violates unique constraint "idx_contacts_account_dni"' }),
    ).toMatch(/otro contacto/);
    expect(
      dniErrorMessage({ code: "23505", message: 'duplicate key value violates unique constraint "idx_contacts_account_phone"' }),
    ).toBeNull();
  });

  it("points at the missing migration", () => {
    expect(
      dniErrorMessage({ code: "PGRST204", message: "Could not find the 'dni' column of 'contacts'" }),
    ).toMatch(/044/);
  });
});
