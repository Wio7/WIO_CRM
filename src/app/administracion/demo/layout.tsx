import { DemoAdministracionShell } from "@/components/administracion/demo-vistas";

// Demostración pública de Administración (sin sesión, datos inventados, no escribe nada).
export default function DemoAdministracionLayout({ children }: { children: React.ReactNode }) {
  return <DemoAdministracionShell>{children}</DemoAdministracionShell>;
}
