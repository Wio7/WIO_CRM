import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformAdminBanner } from "./platform-admin-banner";

const state = vi.hoisted(() => ({
  isVisiting: true,
  isSuperAdmin: true,
  account: { name: "Golden" } as { name: string } | null,
  accountId: "client-id",
  user: { id: "admin" },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => state }));

beforeEach(() => {
  state.isVisiting = true;
  state.account = { name: "Golden" };
});

describe("aviso global de visita", () => {
  it("identifica la cuenta y ofrece Salir sin depender del dashboard", () => {
    const html = renderToStaticMarkup(<PlatformAdminBanner />);
    expect(html).toContain("Estás dentro de «Golden» como superadmin");
    expect(html).toContain("Salir");
    expect(html).toContain("data-platform-admin-banner");
  });
  it("mantiene Salir si no se pudo cargar el nombre", () => {
    state.account = null;
    const html = renderToStaticMarkup(<PlatformAdminBanner />);
    expect(html).toContain("client-id");
    expect(html).toContain("Salir");
  });
  it("no muestra aviso cuando está en casa", () => {
    state.isVisiting = false;
    expect(renderToStaticMarkup(<PlatformAdminBanner />)).toBe("");
  });
});
