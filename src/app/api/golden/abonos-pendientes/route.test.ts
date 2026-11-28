import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notifyUsers = vi.fn();
const pendientes = vi.fn();
const perfiles = vi.fn();

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/push/send", () => ({ notifyUsers: (...a: unknown[]) => notifyUsers(...a) }));
vi.mock("@/lib/golden/aviso-abono", async (orig) => ({
  ...(await orig<typeof import("@/lib/golden/aviso-abono")>()),
  pendientesDesde: (...a: unknown[]) => pendientes(...a),
  perfilesCuenta: (...a: unknown[]) => perfiles(...a),
}));

const { GET } = await import("./route");
const pedido = (headers: Record<string, string> = {}) => new Request("https://crm.test/api/golden/abonos-pendientes", { headers });
const AUTH = { authorization: "Bearer vercel-secret" };

describe("GET /api/golden/abonos-pendientes", () => {
  beforeEach(() => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", "right-secret");
    vi.stubEnv("CRON_SECRET", "vercel-secret");
    perfiles.mockResolvedValue([{ user_id: "leandro", account_role: "owner", area: null }]);
    notifyUsers.mockResolvedValue(1);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("sin el secreto: 401", async () => {
    expect((await GET(pedido({ authorization: "Bearer malo" }))).status).toBe(401);
    expect(pendientes).not.toHaveBeenCalled();
  });

  it("avisa a gerencia cuántos abonos del día siguen pendientes", async () => {
    const hace3h = new Date(Date.now() - 3 * 3600_000).toISOString();
    pendientes.mockResolvedValue([{ account_id: "acc", cantidad: 2, masAntiguo: hace3h }]);
    const res = await GET(pedido(AUTH));
    expect(await res.json()).toEqual({ ok: true, cuentas: 1, enviados: 1 });
    const [, push] = notifyUsers.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(push.userIds).toEqual(["leandro"]);
    expect(push.body).toBe("2 abonos de hoy siguen sin validar. El más antiguo espera 3 h.");
    expect(push.tag).toBe("abonos-pendientes");
  });

  it("sin pendientes no manda nada", async () => {
    pendientes.mockResolvedValue([]);
    expect(await (await GET(pedido(AUTH))).json()).toEqual({ ok: true, cuentas: 0, enviados: 0 });
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it("si la base falla: 500", async () => {
    pendientes.mockResolvedValue("error");
    expect((await GET(pedido(AUTH))).status).toBe(500);
  });
});
