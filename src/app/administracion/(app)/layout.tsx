import { AdministracionShell } from "@/components/administracion/administracion-shell";

export default function AdministracionAppLayout({ children }: { children: React.ReactNode }) {
  return <AdministracionShell>{children}</AdministracionShell>;
}
