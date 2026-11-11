import { beforeEach, describe, expect, it, vi } from "vitest";

// Funcion simple (no vi.fn): vitest marca como fallo un vi.fn que lanza error.
let sesion: { falla?: Error; ctx?: unknown } = {};
const getCurrentAccount = async () => {
  if (sesion.falla) throw sesion.falla;
  return sesion.ctx;
};
vi.mock("@/lib/auth/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/account")>()),
  getCurrentAccount: () => getCurrentAccount(),
}));

const { GET } = await import("./route");
const { UnauthorizedError } = await import("@/lib/auth/account");

interface Fake {
  myArea: string | null;
  members: Record<string, unknown>[];
  account: Record<string, unknown> | null;
}

/** Cliente de sesion falso: guarda los filtros .eq para comprobar el alcance. */
function fakeSupabase(fake: Fake) {
  const eqs: Array<[string, string, unknown]> = [];
  const from = (table: string) => {
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        eqs.push([table, col, val]);
        return chain;
      },
      order: () => Promise.resolve({ data: fake.members, error: null }),
      maybeSingle: () =>
        Promise.resolve({
          data: table === "profiles" ? { area: fake.myArea } : fake.account,
          error: null,
        }),
    };
    return chain;
  };
  return { supabase: { from }, eqs };
}

const account = { id: "acc-1", name: "Golden Habitat", brand_name: null, disabled_modules: ["/broadcasts"] };
const gente = [
  { id: "p1", full_name: "Ana", email: "ana@x.com", account_role: "owner", area: "gerencia" },
  { id: "p2", full_name: "Beto", email: "beto@x.com", account_role: "agent", area: "cobranzas" },
];

function ctxWith(role: string, fake: Fake) {
  const { supabase, eqs } = fakeSupabase(fake);
  sesion = {
    ctx: {
    supabase,
    userId: "user-1",
    accountId: "acc-1",
    role,
    account: { id: "acc-1", name: "Golden Habitat" },
  },
  };
  return eqs;
}

beforeEach(() => {
  sesion = {};
});

describe("GET /api/account/team-tree", () => {
  it("200 para el dueno, con la gente y los modulos de SU cuenta", async () => {
    const eqs = ctxWith("owner", { myArea: null, members: gente, account });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account).toEqual(account);
    expect(body.members).toHaveLength(2);
    // Solo su cuenta: todo filtro por cuenta usa acc-1 (nunca otra).
    const porCuenta = eqs.filter(([, col]) => col === "account_id" || col === "id");
    expect(porCuenta.length).toBeGreaterThan(0);
    expect(porCuenta.every(([, , val]) => val === "acc-1")).toBe(true);
  });

  it("200 para quien tiene area gerencia aunque sea agente", async () => {
    ctxWith("agent", { myArea: "gerencia", members: gente, account });
    expect((await GET()).status).toBe(200);
  });

  it("403 para un agente sin area gerencia, y no lee la lista de gente", async () => {
    const eqs = ctxWith("agent", { myArea: "cobranzas", members: gente, account });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(eqs.some(([, col]) => col === "account_id")).toBe(false);
  });

  it("403 para un admin de ventas", async () => {
    ctxWith("admin", { myArea: "ventas", members: gente, account });
    expect((await GET()).status).toBe(403);
  });

  it("401 sin sesion", async () => {
    sesion = { falla: new UnauthorizedError() };
    expect((await GET()).status).toBe(401);
  });
});
