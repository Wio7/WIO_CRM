import type { Metadata, Viewport } from "next";
import { nombreAppCobranzas } from "@/lib/cobranzas/cuenta-servidor";
import { clasesFuentesGolden } from "@/lib/apps/fuentes";
import { nombreApp } from "@/lib/apps/nombres";
import { CapturaInstalar } from "@/components/apps/captura-instalar";

// App propia de Cobranzas (Fase F4): sin el menú del ERP, con su manifiesto
// (scope /cobranzas) y su nombre armado desde la cuenta.
export async function generateMetadata(): Promise<Metadata> {
  const nombre = await nombreAppCobranzas();
  return {
    title: { absolute: nombre },
    description: "Cuotas vencidas, vouchers y gestiones de cobranza.",
    manifest: nombre === nombreApp("cobranzas", "golden")
      ? "/cobranzas/manifest.webmanifest?cuenta=golden"
      : "/cobranzas/manifest.webmanifest",
    icons: { icon: "/cobranzas-icon.svg", apple: "/cobranzas/icono/180" },
    appleWebApp: { capable: true, title: nombre, statusBarStyle: "default" },
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = { themeColor: "#1d0b0f", width: "device-width", initialScale: 1 };

export default function CobranzasLayout({ children }: { children: React.ReactNode }) {
  // Las fuentes de Golden (Plex y Newsreader) solo se cargan en las apps.
  return (
    <div className={clasesFuentesGolden}>
      <CapturaInstalar scope="/cobranzas" />
      {children}
    </div>
  );
}
