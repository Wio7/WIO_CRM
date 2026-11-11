import { nombreAppCobranzas } from "@/lib/cobranzas/cuenta-servidor";

export const dynamic = "force-dynamic";

// El navegador pide el manifiesto con la cookie de sesión (misma origen), así
// el nombre sale de la cuenta. Sin sesión, nombre genérico.
export async function GET() {
  const nombre = await nombreAppCobranzas();
  return Response.json(
    {
      id: "/cobranzas",
      name: nombre,
      short_name: nombre.replace(/^Golden /, ""),
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
