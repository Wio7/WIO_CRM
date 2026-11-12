"use client";

// Bandeja de traspasos de Administración (componente compartido de F1).
// Todavía ningún traspaso llega a Administración ni sale de ella: los
// contratos en firma, legalizaciones y cartas notariales vienen en F5b.

import { HandoffInbox } from "@/components/handoffs/handoff-inbox";

export default function BandejaAdministracionPagina() {
  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: "var(--ink-3)" }}>
        Aquí llegarán los traspasos entre áreas (contratos en firma, legalizaciones y cartas notariales) cuando esa cadena esté activa.
      </p>
      <HandoffInbox module="administracion" />
    </div>
  );
}
