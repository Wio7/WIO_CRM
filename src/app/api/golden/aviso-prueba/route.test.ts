import { beforeEach, describe, expect, it, vi } from "vitest";

const getRequestAuth = vi.fn();
const notifyUsers = vi.fn();
const limite = vi.fn();

vi.mock("@/lib/supabase/request-auth", () => ({ getRequestAuth: (...a: unknown[]) => getRequestAuth(...a) }));
vi.mock("@/lib/cors", () => ({ corsPreflight: () => new Response(null), withCors: (_r: Request, res: Response) => res }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => limite(...a),
  rateLimitResponse: () => new Response("limit", { status: 429 }),
}));
vi.mock("@/lib/push/send", () => ({ notifyUsers: (...a: unknown[]) => notifyUsers(...a) }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ admin: true }) }));

const { POST } = await import("./route");

const pedido = (cuerpo: object = {}) =>
  new Request("http://x/api/golden/aviso-prueba", { method: "POST", body: JSON.stringify(cuerpo) });

beforeEach(() => {
  vi.clearAllMocks();
  getRequestAuth.mockResolvedValue({ user: { id: "u1" } });
  notifyUsers.mockResolvedValue(2);
  limite.mockReturnValue({ success: true });
});

describe("POST /api/golden/aviso-prueba", () => {
  it("manda la prueba solo a los celulares de quien la pide", async () => {
    const res = await POST(pedido({ url: "https://otra.app/robo" }));
    expect(await res.json()).toEqual({ ok: true, enviados: 2 });
    const [, push] = notifyUsers.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(push.userIds).toEqual(["u1"]);
    expect(push.title).toBe("Prueba de aviso");
    // La URL no sale del cuerpo: cada app abre su propia página de inicio.
    expect(push.url).toBe("/");
    expect(push.tag).toBe("prueba-aviso");
  });

  it("sin sesión: 401 y no manda nada", async () => {
    getRequestAuth.mockResolvedValue({ user: null });
    expect((await POST(pedido())).status).toBe(401);
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it("si no hay celulares suscritos lo dice (enviados 0)", async () => {
    notifyUsers.mockResolvedValue(0);
    expect(await (await POST(pedido())).json()).toEqual({ ok: true, enviados: 0 });
  });

  it("respeta el límite de pruebas por minuto", async () => {
    limite.mockReturnValue({ success: false });
    expect((await POST(pedido())).status).toBe(429);
    expect(notifyUsers).not.toHaveBeenCalled();
  });
});
