import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

describe("state firmado de Meta", () => {
  it("el formato viejo (CRM web) sigue valiendo y no trae app", async () => {
    const { signState, verifyState, verifyStateCompleto } = await import("./oauth");
    const s = signState("cuenta-1");
    expect(verifyState(s)).toBe("cuenta-1");
    expect(verifyStateCompleto(s)).toEqual({ accountId: "cuenta-1", desdeApp: null });
  });

  it("desde la app lleva a dónde volver y quién conectó", async () => {
    const { signState, verifyStateCompleto } = await import("./oauth");
    const s = signState("cuenta-1", { volver: "https://broker.wiocompany.com/#/conectar", userId: "u-1" });
    expect(verifyStateCompleto(s)).toEqual({
      accountId: "cuenta-1",
      desdeApp: { volver: "https://broker.wiocompany.com/#/conectar", userId: "u-1" },
    });
  });

  it("si alguien cambia la dirección de vuelta, el state deja de valer", async () => {
    const { signState, verifyStateCompleto } = await import("./oauth");
    const s = signState("cuenta-1", { volver: "https://broker.wiocompany.com/#/conectar", userId: "u-1" });
    const [codificado, firma] = s.split(".");
    const texto = Buffer.from(codificado, "base64url").toString();
    const partes = texto.split(":");
    partes[3] = Buffer.from(JSON.stringify({ volver: "https://malo.example", userId: "u-1" })).toString("base64url");
    const alterado = `${Buffer.from(partes.join(":")).toString("base64url")}.${firma}`;
    expect(verifyStateCompleto(alterado)).toBeNull();
  });
});

describe("dirección de vuelta", () => {
  it("con resultado dentro del hash de la app", async () => {
    const { volverConResultado } = await import("@/app/api/meta/oauth/callback/route");
    expect(volverConResultado("https://broker.wiocompany.com/#/conectar", { meta: "ok" })).toBe(
      "https://broker.wiocompany.com/#/conectar?meta=ok",
    );
    expect(volverConResultado("https://x.wiocompany.com/#/c?a=1", { meta_error: "No" })).toBe(
      "https://x.wiocompany.com/#/c?a=1&meta_error=No",
    );
  });

  it("solo a orígenes permitidos y con https", async () => {
    const { volverValido } = await import("@/app/api/meta/oauth/enlace/route");
    expect(volverValido("https://broker.wiocompany.com/#/conectar")).toBe("https://broker.wiocompany.com/#/conectar");
    expect(volverValido("https://malo.example/#/x")).toBeNull();
    expect(volverValido("http://broker.wiocompany.com/")).toBeNull();
    expect(volverValido("javascript:alert(1)")).toBeNull();
    expect(volverValido(null)).toBeNull();
  });
});
