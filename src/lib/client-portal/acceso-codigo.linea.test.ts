import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { sendTextMessage } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async (..._a: unknown[]) => ({ messageId: "w" })),
}));
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/meta-api")>()),
  sendTextMessage,
}));
vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: vi.fn((v: string) => `plain:${v}`),
}));

import { mandarPorWhatsApp } from "./acceso-codigo";

// whatsapp_config: devuelve la fila primaria aunque la cuenta tenga más líneas.
function dbWith(lines: Array<Record<string, unknown>>): SupabaseClient {
  return {
    from() {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
      const row = () => ({
        data: [...lines].sort((x, y) => Number(y.is_primary) - Number(x.is_primary))[0] ?? null,
        error: null,
      });
      // `.single()` fallaría con 2+ filas, como en la base real.
      b.single = () =>
        Promise.resolve(lines.length === 1 ? row() : { data: null, error: { message: "multiple rows" } });
      b.maybeSingle = () => Promise.resolve(row());
      return b;
    },
  } as unknown as SupabaseClient;
}

const A = { id: "line-A", phone_number_id: "PNID-A", access_token: "tok-A", is_primary: true };
const B = { id: "line-B", phone_number_id: "PNID-B", access_token: "tok-B", is_primary: false };

describe("mandarPorWhatsApp — línea principal", () => {
  beforeEach(() => sendTextMessage.mockClear());

  it("con dos líneas sale por la principal", async () => {
    await mandarPorWhatsApp(dbWith([B, A]), "acct-1", "+51999111222", "hola");
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "PNID-A", accessToken: "plain:tok-A" }),
    );
  });

  it("con una línea sigue igual", async () => {
    await mandarPorWhatsApp(dbWith([A]), "acct-1", "+51999111222", "hola");
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "PNID-A" }));
  });

  it("sin líneas lanza el mismo error de siempre", async () => {
    await expect(mandarPorWhatsApp(dbWith([]), "acct-1", "+51999111222", "hola")).rejects.toThrow(
      "WhatsApp no está configurado",
    );
  });
});
