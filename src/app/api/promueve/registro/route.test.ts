import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCodigo } from "@/lib/promueve/registro";

const rpc = vi.fn();
const createUser = vi.fn();
const deleteUser = vi.fn(async () => ({ error: null }));
const borrarCuenta = vi.fn();
const perfil = vi.fn();
let limite = { success: true as boolean };
const llaves: string[] = [];

vi.mock("@/lib/cors", () => ({ corsPreflight: () => new Response(null), withCors: (_r: Request, res: Response) => res }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (key: string) => {
    llaves.push(key);
    return { ...limite, reset: Date.now() + 1000, remaining: 0, limit: 1 };
  },
  rateLimitResponse: () => new Response("limit", { status: 429 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    rpc: (...a: unknown[]) => rpc(...a),
    auth: { admin: { createUser: (...a: unknown[]) => createUser(...a), deleteUser: (...a: unknown[]) => deleteUser(...a) } },
    from: (tabla: string) =>
      tabla === "profiles"
        ? { select: () => ({ eq: () => ({ maybeSingle: perfil }) }) }
        : { delete: () => ({ eq: () => ({ eq: borrarCuenta }) }) },
  }),
}));

const { POST } = await import("./route");

const cuerpo = {
  nombre: "María Pérez",
  celular: "987654321",
  correo: "maria@example.com",
  password: "una-clave-larga",
  codigo: "AB12-CD34-EF56",
};
const pedido = (b: unknown = cuerpo, ip = "1.2.3.4") =>
  new Request("http://x/api/promueve/registro", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify(b),
  });

beforeEach(() => {
  vi.clearAllMocks();
  llaves.length = 0;
  limite = { success: true };
  rpc.mockImplementation(async (nombre: string) =>
    nombre === "promueve_check_code" ? { data: "cuenta-golden", error: null } : { data: "cuenta-golden", error: null },
  );
  createUser.mockResolvedValue({ data: { user: { id: "u-nuevo" } }, error: null });
  perfil.mockResolvedValue({ data: { account_id: "personal" } });
  borrarCuenta.mockResolvedValue({});
});

describe("POST /api/promueve/registro", () => {
  it("con código bueno crea el usuario, registra el perfil con el hash y responde ok", async () => {
    const res = await POST(pedido());
    expect(await res.json()).toEqual({ ok: true });
    const hash = hashCodigo("AB12CD34EF56");
    expect(rpc).toHaveBeenCalledWith("promueve_check_code", { p_code_hash: hash });
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "maria@example.com", email_confirm: true }),
    );
    expect(rpc).toHaveBeenCalledWith("promueve_registrar", {
      p_user_id: "u-nuevo",
      p_full_name: "María Pérez",
      p_phone: "+51987654321",
      p_code_hash: hash,
    });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("sin código válido no toca Auth", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(pedido());
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("invalid_code");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("datos malos: 400 con el campo, sin consultar nada", async () => {
    const res = await POST(pedido({ ...cuerpo, celular: "123" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, reason: "invalid_input", campo: "celular" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("correo repetido: misma respuesta genérica, sin decir que existe", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: "email_exists", status: 422, message: "User already registered" } });
    const res = await POST(pedido());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe("no_se_pudo");
    expect(JSON.stringify(json)).not.toMatch(/registered|exists|ya existe/i);
    expect(rpc).not.toHaveBeenCalledWith("promueve_registrar", expect.anything());
  });

  it("si el registro del perfil falla, borra la cuenta personal y el usuario de Auth", async () => {
    rpc.mockImplementation(async (nombre: string) =>
      nombre === "promueve_check_code"
        ? { data: "cuenta-golden", error: null }
        : { data: null, error: { code: "XX000", message: "boom" } },
    );
    const res = await POST(pedido());
    expect(res.status).toBe(500);
    expect(borrarCuenta).toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("u-nuevo");
  });

  it("si otro se ganó el último uso del código, lo dice y no deja al usuario", async () => {
    rpc.mockImplementation(async (nombre: string) =>
      nombre === "promueve_check_code"
        ? { data: "cuenta-golden", error: null }
        : { data: null, error: { code: "22023", message: "Código no válido" } },
    );
    const res = await POST(pedido());
    expect((await res.json()).reason).toBe("invalid_code");
    expect(deleteUser).toHaveBeenCalledWith("u-nuevo");
  });

  it("limita por IP y por correo", async () => {
    await POST(pedido(cuerpo, "9.9.9.9"));
    expect(llaves).toEqual(["promueve-registro:ip:9.9.9.9", "promueve-registro:correo:maria@example.com"]);
    limite = { success: false };
    const res = await POST(pedido());
    expect(res.status).toBe(429);
    expect(createUser).toHaveBeenCalledTimes(1);
  });
});
