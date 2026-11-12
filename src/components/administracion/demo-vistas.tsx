"use client";

// Pantallas de la demostración de Administración (/administracion/demo): las
// mismas piezas de la app con datos inventados. No lee ni escribe nada.

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { FileSpreadsheet, Landmark, ListChecks } from "lucide-react";

import { GoldenBody, GoldenFrame, type SeccionApp } from "@/components/apps/golden-frame";
import { estadoCuentaDemo } from "@/lib/administracion/demo-datos";
import { resumirMovimientos } from "@/lib/administracion/estado-cuenta";

import { MovimientosView } from "./movimientos-view";
import { PorValidarView } from "./por-validar-view";
import { ResumenView } from "./resumen-view";

const BASE = "/administracion/demo";

const SECCIONES_DEMO: readonly SeccionApp[] = [
  { href: BASE, etiqueta: "Resumen", largo: "Resumen", icono: Landmark, exacta: true },
  { href: `${BASE}/estado-de-cuenta`, etiqueta: "Estado", largo: "Estado de cuenta", icono: FileSpreadsheet },
  { href: `${BASE}/por-validar`, etiqueta: "Validar", largo: "Por validar", icono: ListChecks },
];

export function DemoAdministracionShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <GoldenBody app="administracion">
      <GoldenFrame
        nombre="Golden Administración"
        subtitulo="GOLDEN · DREAM HABITAT"
        icono={Landmark}
        secciones={SECCIONES_DEMO}
        pathname={pathname}
        rotuloDemo="Demostración · datos inventados"
      >
        {children}
      </GoldenFrame>
    </GoldenBody>
  );
}

export function ResumenDemo() {
  const d = useMemo(() => estadoCuentaDemo(), []);
  const resumen = useMemo(() => resumirMovimientos(d.movimientos), [d]);
  const falta = d.movimientos.filter((m) => m.deposito > 0 && (m.estado === "por_conciliar" || m.estado === "revisar")).length;
  return (
    <ResumenView
      mes={d.mes}
      resumen={resumen}
      faltaConciliar={falta}
      vacio={false}
      hrefEstado={`${BASE}/estado-de-cuenta`}
      hrefPorValidar={`${BASE}/por-validar`}
    />
  );
}

export function EstadoDemo() {
  const d = useMemo(() => estadoCuentaDemo(), []);
  return (
    <div className="space-y-4">
      <div className="gdrop">
        <p className="text-sm">
          <strong>Sube el estado de cuenta de la Caja Ica</strong> (el .xls que baja del banco). En la demostración no se sube nada.
        </p>
        <button type="button" className="gbtn" disabled title="En la demostración no se sube nada">Elegir archivo</button>
      </div>
      <MovimientosView movimientos={d.movimientos} />
    </div>
  );
}

export function PorValidarDemo() {
  const d = useMemo(() => estadoCuentaDemo(), []);
  return <PorValidarView movimientos={d.movimientos} pagos={d.pagos} />;
}
