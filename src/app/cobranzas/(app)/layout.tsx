import { CobranzasShell } from "@/components/cobranzas/cobranzas-shell";

export default function CobranzasAppLayout({ children }: { children: React.ReactNode }) {
  return <CobranzasShell>{children}</CobranzasShell>;
}
