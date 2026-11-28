import { beforeEach, describe, expect, it, vi } from "vitest";

const getRequestAuth = vi.fn();
const notifyUsers = vi.fn();
const leer = vi.fn();
const perfiles = vi.fn();

vi.mock("@/lib/supabase/request-auth", () => ({ getRequestAuth: (...a: unknown[]) => getRequestAuth(...a) }));
vi.mock("@/lib/cors", () => ({ corsPreflight: () => new Response(null), withCors: (_r: Request, res: Response) => res }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response("limit", { status: 429 }),
}));
vi.mock("@/lib/push/send", () => ({ notifyUsers: (...a: unknown[]) => notifyUsers(...a) }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/golden/aviso-abono", async (orig) => ({
  ...(await orig<typeof import("@/lib/golden/aviso-abono")>()),
  leerSolicitudAbono: (...a: unknown[]) => leer(...a),
  perfilesCuenta: (...a: unknown[]) => perfiles(...a),
}));

const { POST } = await import("./route");

const ID = "11111111-1111-4111-8111-111111111111";
const pedido = (cuerpo: object) =>
  new Request("http://x/api/golden/abono-por-validar", { method: "POST", body: JSON.stringify(cuerpo) });
const sesion = (rol = "agent", cuenta = "acc") =>
  getRequestAuth.mockResolvedValue({
    user: { id: "sthefany" },
    supabase: {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_id: cuenta, account_role: rol } }) }) }),
      }),
    },
  });
const solicitud = (cambios: Record<string, unknown> = {}) =>
  leer.mockResolvedValue({
    id: ID,
    account_id: "acc",
    kind: "validacion_abono",
    estado: "pendiente",
    created_at: new Date().toISOString(),
    resumen: { cliente: "Ana Ruiz", proyecto: "Colinas 2", unidad: "H-26", monto_centimos: 85000, moneda: "PEN" },
    solicitado_por: "sthefany",
    solicitado_por_nombre: "Sthefany",
    ...cambios,
  });

beforeEach(() => {
  vi.clearAllMocks();
  sesion();
  solicitud();
  perfiles.mockResolvedValue([
    { user_id: "leandro", account_role: "owner", area: null },
    { user_id: "eric", account_role: "owner", area: null },
    { user_id: "sthefany", account_role: "agent", area: "cobranzas" },
  ]);
  notifyUsers.mockResolvedValue(3);
});

describe("POST /api/golden/abono-por-validar", () => {
  it("avisa a gerencia con los datos leídos de la base, no del cuerpo", async () => {
    const res = await POST(pedido({ solicitud_id: ID, monto: "999999" }));
    expect(await res.json()).toEqual({ ok: true, enviados: 3 });
    const [, push] = notifyUsers.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(push.userIds).toEqual(["leandro", "eric"]);
    expect(push.title).toBe("Abono por validar");
    expect(push.body).toBe("Ana Ruiz · Colinas 2 H-26 · S/ 850.00 (de Sthefany)");
    expect(push.url).toBe("https://gerencia-golden.vercel.app/aprobaciones");
    expect(push.tag).toBe(`abono-${ID}`);
  });

  it("sin sesión: 401", async () => {
    getRequestAuth.mockResolvedValue({ user: null });
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(401);
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it("solo lectura no puede disparar avisos", async () => {
    sesion("viewer");
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(403);
  });

  it("id mal formado: 400", async () => {
    expect((await POST(pedido({ solicitud_id: "x" }))).status).toBe(400);
    expect(leer).not.toHaveBeenCalled();
  });

  it.each([
    ["otra cuenta", { account_id: "otra" }],
    ["otro tipo", { kind: "promocion" }],
    ["ya resuelta", { estado: "aprobada" }],
    ["la mandó otra persona", { solicitado_por: "otro" }],
    ["es vieja", { created_at: "2026-01-01T00:00:00Z" }],
  ])("no avisa si %s", async (_n, cambios) => {
    solicitud(cambios);
    const res = await POST(pedido({ solicitud_id: ID }));
    expect(await res.json()).toEqual({ ok: false, reason: "not_applicable" });
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it("si la solicitud no existe o la base falla, no avisa", async () => {
    leer.mockResolvedValue(null);
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(404);
    leer.mockResolvedValue("error");
    expect((await POST(pedido({ solicitud_id: ID }))).status).toBe(502);
    expect(notifyUsers).not.toHaveBeenCalled();
  });
});
