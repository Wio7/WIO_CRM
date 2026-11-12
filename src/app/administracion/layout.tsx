import type { Metadata, Viewport } from "next";
import { nombreAppAdministracion } from "@/lib/administracion/cuenta-servidor";
import { clasesFuentesGolden } from "@/lib/apps/fuentes";

// App propia de Administración (Fase F5): sin el menú del ERP, con su manifiesto
// (scope /administracion) y su nombre armado desde la cuenta.
export async function generateMetadata(): Promise<Metadata> {
  const nombre = await nombreAppAdministracion();
  return {
    title: { absolute: nombre },
    description: "Estado de cuenta de la Caja Ica, abonos y pagos por validar.",
    manifest: "/administracion/manifest.webmanifest",
    icons: { icon: "/administracion-icon.svg", apple: "/administracion/icono/180" },
    appleWebApp: { capable: true, title: nombre, statusBarStyle: "default" },
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = { themeColor: "#1d0b0f", width: "device-width", initialScale: 1 };

export default function AdministracionLayout({ children }: { children: React.ReactNode }) {
  // Las fuentes de Golden (Plex y Newsreader) solo se cargan en las apps.
  return <div className={clasesFuentesGolden}>{children}</div>;
}
