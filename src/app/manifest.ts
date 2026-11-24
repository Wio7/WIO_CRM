import type { MetadataRoute } from "next";

// Makes the CRM installable on phones ("Agregar a pantalla de inicio").
// Golden Caja has its own manifest under /caja (scope /caja), which its
// layout links instead of this one, so the two install as separate apps.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/dashboard",
    name: "Wio Suite",
    short_name: "Wio Suite",
    description: "Clientes, ventas y operación de tu empresa en un solo lugar.",
    lang: "es-PE",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#090b0f",
    theme_color: "#020617",
    icons: [
      { src: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/app-icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/app-icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
