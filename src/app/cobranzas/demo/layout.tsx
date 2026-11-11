import { DemoCobranzasShell } from "@/components/cobranzas/demo-vistas";

// Demostración pública de Cobranzas (sin sesión, datos inventados, no escribe nada).
export default function DemoCobranzasLayout({ children }: { children: React.ReactNode }) {
  return <DemoCobranzasShell>{children}</DemoCobranzasShell>;
}
