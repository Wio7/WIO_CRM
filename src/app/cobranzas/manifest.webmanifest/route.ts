import { nombreAppCobranzas } from "@/lib/cobranzas/cuenta-servidor";
import { nombreApp } from "@/lib/apps/nombres";

export const dynamic = "force-dynamic";

// Chrome pide el manifiesto SIN la cookie de sesión, así que la página le
// pasa ?cuenta=golden (lo decide el layout con la sesión). Sin eso, se intenta
// con la sesión y si no hay, nombre genérico.
export async function GET(req: Request) {
  const cuenta = new URL(req.url).searchParams.get("cuenta");
  const nombre = cuenta === "golden" ? nombreApp("cobranzas", "golden") : await nombreAppCobranzas();
  return Response.json(
    {
      id: "/cobranzas",
      name: nombre,
      short_name: nombre,
      lang: "es-PE",
      start_url: "/cobranzas",
      scope: "/cobranzas",
      display: "standalone",
      background_color: "#f5f1ea",
      theme_color: "#1d0b0f",
      icons: [
        { src: "/cobranzas/icono/192", sizes: "192x192", type: "image/png" },
        { src: "/cobranzas/icono/512", sizes: "512x512", type: "image/png" },
        { src: "/cobranzas-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}
