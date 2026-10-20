import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "./account";
import { POST as create } from "@/app/api/admin/accounts/create/route";
import { POST as remove } from "@/app/api/admin/accounts/delete/route";
import { POST as invite } from "@/app/api/admin/accounts/[accountId]/invitations/route";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), serviceClient: vi.fn() }));
vi.mock("@/lib/auth/account", async (original) => ({
  ...await original<typeof import("./account")>(),
  requireSuperAdmin: mocks.guard,
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.serviceClient }));

const request = (body = {}) => new Request("http://localhost/api/admin/accounts", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const handlers = [
  { name: "crear", call: () => create(request()) },
  { name: "eliminar", call: () => remove(request()) },
  { name: "invitar", call: () => invite(request(), { params: Promise.resolve({ accountId: "client" }) }) },
];
beforeEach(() => vi.clearAllMocks());

describe("rutas exclusivas de superadmin", () => {
  for (const handler of handlers) {
    it.each([new UnauthorizedError(), new ForbiddenError()])(`${handler.name}: rechaza antes de crear el cliente de servicio (%j)`, async (error) => {
      mocks.guard.mockRejectedValue(error);
      expect((await handler.call()).status).toBe(error.status);
      expect(mocks.serviceClient).not.toHaveBeenCalled();
    });
  }
  it.each(["home", "client"])("impide borrar la cuenta protegida %s antes de borrar usuarios", async (accountId) => {
    mocks.guard.mockResolvedValue({ userId: "admin", platformAdmin: { home_account_id: "home", visiting_account_id: "client" } });
    expect((await remove(request({ accountId }))).status).toBe(409);
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });
});
