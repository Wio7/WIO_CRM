import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_SWITCH_EVENT, switchPlatformAccount } from "./account-switch";

afterEach(() => vi.unstubAllGlobals());

describe("cambio de cuenta", () => {
  it.each(["client", null])("recarga tras confirmar el RPC: %s", async (id) => {
    const assign = vi.fn();
    const setItem = vi.fn();
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.stubGlobal("window", { location: { assign } });
    vi.stubGlobal("localStorage", { setItem });
    await switchPlatformAccount({ rpc } as unknown as SupabaseClient, id);
    expect(rpc.mock.calls).toEqual([id === null
      ? ["platform_admin_exit_account"]
      : ["platform_admin_enter_account", { p_account_id: id }]]);
    expect(setItem).toHaveBeenCalledWith(ACCOUNT_SWITCH_EVENT, expect.any(String));
    expect(assign).toHaveBeenCalledWith(id === null ? "/saas-owner" : "/dashboard");
  });

  it.each([
    ["/collections", "/collections"],
    ["//evil.com", "/dashboard"],
    ["https://evil.com", "/dashboard"],
  ])("tras entrar a una cuenta va al destino %s solo si es una ruta propia", async (destino, esperado) => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await switchPlatformAccount({ rpc } as unknown as SupabaseClient, "client", destino);
    expect(assign).toHaveBeenCalledWith(esperado);
  });

  it("conserva la pantalla y no avisa a otras pestañas si falla el RPC", async () => {
    const assign = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    vi.stubGlobal("localStorage", { setItem });
    const error = { message: "Sin permiso" };
    const rpc = vi.fn().mockResolvedValue({ error });
    await expect(switchPlatformAccount({ rpc } as unknown as SupabaseClient, "client")).rejects.toEqual(error);
    expect(assign).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
});
