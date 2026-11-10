import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/v1/respond";

// La API key y el cliente de servicio se simulan: aqui se prueba el
// contrato HTTP (cuerpo, envelope, codigos) y que todo se filtre por la
// cuenta de la key.
const requireApiKey = vi.fn();
vi.mock("@/lib/auth/api-context", () => ({
  requireApiKey: async (...a: unknown[]) => requireApiKey(...a),
}));

const ACCOUNT = "acct-1";
const P1 = "7b0f3c1e-5a52-4f7e-9d3c-2b1a8f0e6c11";

interface Calls {
  eq: [string, unknown][];
  table: string[];
  rpc: [string, Record<string, unknown>][];
}

function fakeSupabase(
  tables: Record<string, unknown>,
  rpcResult: { data: unknown; error: { code?: string; message: string } | null } = { data: null, error: null },
) {
  const calls: Calls = { eq: [], table: [], rpc: [] };
  const supabase = {
    from(table: string) {
      calls.table.push(table);
      const result = { data: tables[table] ?? null, error: null };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "order"]) q[m] = () => q;
      q.eq = (c: string, v: unknown) => {
        calls.eq.push([c, v]);
        return q;
      };
      q.maybeSingle = () => Promise.resolve(result);
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return q;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push([name, args]);
      return Promise.resolve(rpcResult);
    },
  };
  return { supabase, calls };
}

function ctx(supabase: unknown) {
  return { authType: "api_key", supabase, accountId: ACCOUNT, keyId: "k1", scopes: [], createdBy: "u" };
}

function post(body: unknown) {
  return new Request("https://crm.test/api/v1/store/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = () => ({
  customer: { name: "Ana", phone: "999111222" },
  shipping: { method: "shalom", city: "Ica", address: "Av. Grau 1" },
  payment_method: "yape",
  items: [{ product_id: P1, quantity: 2 }],
});

beforeEach(() => {
  requireApiKey.mockReset();
});

describe("GET /api/v1/store/catalog", () => {
  it("devuelve la tienda y solo los productos activos, filtrando por la cuenta de la key", async () => {
    const { supabase, calls } = fakeSupabase({
      accounts: { name: "Vendedor SAC", brand_name: "Vita Life", logo_url: "https://x/logo.png" },
      store_settings: {
        enabled: true,
        whatsapp: "+51919649875",
        yape_number: "900292154",
        yape_holder: "Jhosseph",
        mercadopago_holder: "Jhosseph",
        mercadopago_link: null,
        shipping_note: "Envios gratis",
        currency: "PEN",
      },
      store_products: [
        {
          id: P1, name: "Basico", subtitle: "1 caja", description: null, price: "269.00", currency: "PEN",
          image_url: null, includes: ["1 caja"], badge: null, sort: 0,
        },
      ],
    });
    requireApiKey.mockResolvedValue(ctx(supabase));
    const { GET } = await import("./catalog/route");
    const res = await GET(new Request("https://crm.test/api/v1/store/catalog"));
    expect(requireApiKey).toHaveBeenCalledWith(expect.any(Request), "store:read");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        store: {
          name: "Vita Life",
          logo_url: "https://x/logo.png",
          whatsapp: "+51919649875",
          yape_number: "900292154",
          yape_holder: "Jhosseph",
          mercadopago_holder: "Jhosseph",
          mercadopago_link: null,
          shipping_note: "Envios gratis",
          currency: "PEN",
          enabled: true,
        },
        products: [
          {
            id: P1, name: "Basico", subtitle: "1 caja", description: null, price: 269, currency: "PEN",
            image_url: null, includes: ["1 caja"], badge: null, sort: 0,
          },
        ],
      },
    });
    expect(calls.eq).toContainEqual(["account_id", ACCOUNT]);
    expect(calls.eq).toContainEqual(["active", true]);
    expect(calls.eq).toContainEqual(["id", ACCOUNT]);
  });

  it("si la cuenta no configuro la tienda, la deja apagada y sin productos", async () => {
    const { supabase } = fakeSupabase({ accounts: { name: "Solo Nombre", brand_name: null, logo_url: null }, store_products: [] });
    requireApiKey.mockResolvedValue(ctx(supabase));
    const { GET } = await import("./catalog/route");
    const body = await (await GET(new Request("https://crm.test/x"))).json();
    expect(body.data.store.enabled).toBe(false);
    expect(body.data.store.name).toBe("Solo Nombre");
    expect(body.data.products).toEqual([]);
  });

  it("propaga el 403 si la key no tiene el scope", async () => {
    const err = new ApiError("forbidden", "falta scope", 403);
    requireApiKey.mockImplementation(() => {
      throw err;
    });
    const { GET } = await import("./catalog/route");
    const res = await GET(new Request("https://crm.test/x"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "falta scope" } });
  });
});

describe("POST /api/v1/store/orders", () => {
  it("crea el pedido con la base (rpc) y responde 201 con el envelope", async () => {
    const order = { id: "o1", code: "VL-0001", total: 538, currency: "PEN", status: "nuevo", items: [] };
    const { supabase, calls } = fakeSupabase({}, { data: order, error: null });
    requireApiKey.mockResolvedValue(ctx(supabase));
    const { POST } = await import("./orders/route");
    const res = await POST(post({ ...validBody(), total: 1, items: [{ product_id: P1, quantity: 2, price: 1 }] }));
    expect(requireApiKey).toHaveBeenCalledWith(expect.any(Request), "store:write");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { order } });
    expect(calls.rpc).toHaveLength(1);
    const [name, args] = calls.rpc[0];
    expect(name).toBe("store_create_order");
    expect(args.p_account_id).toBe(ACCOUNT);
    // Solo viaja lo validado: ni total ni precio del cliente.
    expect(JSON.stringify(args.payload)).not.toContain("price");
    expect((args.payload as { total?: number }).total).toBeUndefined();
    expect((args.payload as { items: unknown }).items).toEqual([{ product_id: P1, quantity: 2 }]);
  });

  it("400 con mensaje en espanol si el cuerpo no es valido, sin tocar la base", async () => {
    const { supabase, calls } = fakeSupabase({});
    requireApiKey.mockResolvedValue(ctx(supabase));
    const { POST } = await import("./orders/route");
    const res = await POST(post({ ...validBody(), payment_method: "bitcoin" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("pago");
    expect(calls.rpc).toHaveLength(0);
  });

  it("400 si el JSON esta mal formado", async () => {
    requireApiKey.mockResolvedValue(ctx(fakeSupabase({}).supabase));
    const { POST } = await import("./orders/route");
    const res = await POST(post("{no es json"));
    expect(res.status).toBe(400);
  });

  it("400 con el mensaje de la base cuando un producto no esta disponible", async () => {
    const { supabase } = fakeSupabase({}, { data: null, error: { code: "22023", message: "Uno de los productos no esta disponible" } });
    requireApiKey.mockResolvedValue(ctx(supabase));
    const { POST } = await import("./orders/route");
    const res = await POST(post(validBody()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({ code: "bad_request", message: "Uno de los productos no esta disponible" });
  });

  it("409 store_disabled cuando la tienda esta apagada", async () => {
    const { supabase } = fakeSupabase({}, { data: null, error: { code: "55000", message: "La tienda no esta disponible" } });
    requireApiKey.mockResolvedValue(ctx(supabase));
    const { POST } = await import("./orders/route");
    const res = await POST(post(validBody()));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("store_disabled");
  });

  it("500 generico si la base falla por otra causa", async () => {
    const { supabase } = fakeSupabase({}, { data: null, error: { code: "XX000", message: "boom interno" } });
    requireApiKey.mockResolvedValue(ctx(supabase));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./orders/route");
    const res = await POST(post(validBody()));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
    spy.mockRestore();
  });
});
