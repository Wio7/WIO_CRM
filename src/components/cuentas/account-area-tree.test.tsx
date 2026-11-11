import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountAreaTree } from "./account-area-tree";

const cuenta = { name: "Golden Habitat", brand_name: null, disabled_modules: [] as string[] };

describe("AccountAreaTree", () => {
  it("Administración sale como grupo propio en celeste, con su gente; el resto no", () => {
    const html = renderToStaticMarkup(
      <AccountAreaTree
        cuenta={cuenta}
        miembros={[
          { id: "a", full_name: "Celeste", email: "c@x.com", account_role: "admin", area: "administracion" },
          { id: "b", full_name: "Luisin", email: "l@x.com", account_role: "agent", area: "contabilidad" },
        ]}
      />,
    );
    const secciones = html.split("<section").slice(1);
    const admin = secciones.find((s) => s.includes('data-acento="celeste"'));
    expect(admin).toBeDefined();
    expect(admin).toContain("Administración");
    expect(admin).toContain("Celeste");
    expect(admin).toContain("border-sky-400/40");
    expect(admin).not.toContain("Luisin");
    // Solo una sección lleva el acento; Contabilidad conserva su estilo neutro.
    expect(secciones.filter((s) => s.includes("data-acento")).length).toBe(1);
    const conta = secciones.find((s) => s.includes("Luisin"))!;
    expect(conta).toContain("Contabilidad");
    expect(conta).toContain("border-white/5");
  });
});
