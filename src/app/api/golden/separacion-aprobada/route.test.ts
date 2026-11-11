import { beforeEach, describe, expect, it, vi } from "vitest";

const getRequestAuth = vi.fn();
const consultar = vi.fn();
const notifyTeam = vi.fn();
const insert = vi.fn();
const eqDelete = vi.fn(async () => ({}));

vi.mock("@/lib/supabase/request-auth", () => ({ getRequestAuth: (...a: unknown[]) => getRequestAuth(...a) }));
vi.mock("@/lib/cors", () => ({ corsPreflight: () => new Response(null), withCors: (_r: Request, res: Response) => res }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response("limit", { status: 429 }),
}));
vi.mock("@/lib/push/send", () => ({ notifyTeam: (...a: unknown[]) => notifyTeam(...a) }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => ({ insert: (...a: unknown[]) => insert(...a), delete: () => ({ eq: eqDelete }) }),
  }),
}));
vi.mock("@/lib/golden/aviso-separacion", async (importarOriginal) => ({
  ...(await importarOriginal<typeof import("@/lib/golden/aviso-separacion")>()),
  consultarSeparacionAprobada: (...a: unknown[]) => consultar(...a),
}));

const { POST } = await import("./route");

const ID = "11111111-1111-4111-8111-111111111111";
const pedido = (cuerpo: object) =>
  new Request("http://x/api/golden/separacion-aprobada", { method: "POST", body: JSON.stringify(cuerpo) });

const sesion = (rol: string | null = "agent") =>
  getRequestAuth.mockResolvedValue({
    user: { id: "u1" },
    supabase: {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rol ? { account_id: "acc", account_role: rol } : null }) }) }),
      }),
    },
  });

const aprobada = (resuelta = new Date().toISOString()) =>
  consultar.mockResolvedValue({
    estado: "aprobada",
    solicitud: { proyecto: "colinas-2", lote: "H-26", asesor: "Carlos", resuelta },
  });

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue({ error: null });
  notifyTeam.mockResolvedValue(4);
  sesion();
  aprobada();
});

describe("POST /api/golden/separacion-aprobada", () => {
  it("avisa a todo el equipo con proyecto, lote y asesor leídos del catálogo, no del cuerpo", async () => {
    const res = await POST(pedido({ solicitud_id: ID, nombre_proyecto: "Colinas 2", lote: "Z-99", asesor: "Falso" }));
    expect(await res.json()).toEqual({ ok: true, enviados: 4 });
    const [, push] = notifyTeam.mock.calls[0] as [unknown, Record<string, string>];
    expect(push).toMatchObject({
      accountId: "acc",
      title: "Lote separado",
      body: "Colinas 2 · H-26 (Carlos)",
      url: "/#/lotes/colinas-2",
    });
  });

  it("sin sesión: 401 y no consulta nada", async () => {
    getRequestAuth.mockResolvedValue({ user: null });
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(401);
    expect(consultar).not.toHaveBeenCalled();
  });

  it("un usuario de solo lectura (cliente o invitado) no puede disparar avisos", async () => {
    sesion("viewer");
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(403);
    expect(notifyTeam).not.toHaveBeenCalled();
  });

  it("id que no es uuid: 400", async () => {
    expect((await POST(pedido({ solicitud_id: "abc" }))).status).toBe(400);
  });

  it("solicitud no aprobada (pendiente, rechazada o inventada): 409 y no avisa", async () => {
    consultar.mockResolvedValue({ estado: "no_aprobada" });
    const res = await POST(pedido({ solicitud_id: ID }));
    expect(res.status).toBe(409);
    expect(notifyTeam).not.toHaveBeenCalled();
  });

  it("aprobación vieja: 409 y no avisa", async () => {
    aprobada(new Date(Date.now() - 3 * 3600_000).toISOString());
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(409);
    expect(notifyTeam).not.toHaveBeenCalled();
  });

  it("catálogo caído o sin configurar: no avisa por las dudas", async () => {
    consultar.mockResolvedValue({ estado: "error" });
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(502);
    consultar.mockResolvedValue({ estado: "sin_config" });
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(503);
    expect(notifyTeam).not.toHaveBeenCalled();
  });

  it("idempotente: si el aviso ya salió (clave repetida) no envía otra vez", async () => {
    insert.mockResolvedValue({ error: { code: "23505", message: "dup" } });
    const res = await POST(pedido({ solicitud_id: ID }));
    expect(await res.json()).toEqual({ ok: true, enviados: 0, duplicado: true });
    expect(notifyTeam).not.toHaveBeenCalled();
  });

  it("si no llegó a ningún celular libera la reserva para reintentar", async () => {
    notifyTeam.mockResolvedValue(0);
    const res = await POST(pedido({ solicitud_id: ID }));
    expect(await res.json()).toEqual({ ok: true, enviados: 0 });
    expect(eqDelete).toHaveBeenCalledWith("solicitud_id", ID);
  });
});
