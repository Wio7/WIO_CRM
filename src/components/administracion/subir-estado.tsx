"use client";

// Subir el estado de cuenta (.xls) de la Caja Ica. El archivo se lee en este
// navegador (SheetJS) y no sale del equipo: solo las filas ya leídas viajan
// al RPC de importación cuando se confirma. Reimportar el mismo archivo no
// duplica (la base ignora las huellas repetidas).

import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { dinero } from "@/lib/cobranzas/dinero";
import { cargarMes } from "@/lib/administracion/datos";
import { conciliarDatos } from "@/lib/administracion/conciliar-datos";
import { ETIQUETA_TIPO, type ResultadoLectura } from "@/lib/administracion/estado-cuenta";
import { mesesEntre } from "@/lib/administracion/formato";
import { leerArchivoXls } from "@/lib/administracion/leer-xls";
import { armarPayloadImportacion, importarEstadoCuenta } from "@/lib/administracion/rpc";

import { Aviso } from "./piezas";

type Lectura = Extract<ResultadoLectura, { ok: true }>;

interface Props {
  supabase: ReturnType<typeof createClient>;
  /** Tras importar: el mes a mostrar y recargar. */
  onImportado: (mes: string) => void;
}

export function SubirEstado({ supabase, onImportado }: Props) {
  const entrada = useRef<HTMLInputElement>(null);
  const [archivo, setArchivo] = useState<string | null>(null);
  const [lectura, setLectura] = useState<Lectura | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [importando, setImportando] = useState(false);

  async function elegido(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError(null);
    setMensaje(null);
    setLectura(null);
    setArchivo(f.name);
    setLeyendo(true);
    const r = await leerArchivoXls(await f.arrayBuffer(), f.name);
    setLeyendo(false);
    if (!r.ok) setError(r.error);
    else setLectura(r);
  }

  async function importar() {
    if (!lectura) return;
    setImportando(true);
    setError(null);
    const r = await importarEstadoCuenta(supabase, armarPayloadImportacion(lectura, archivo));
    if (!r.ok) {
      setError(r.message);
      setImportando(false);
      return;
    }
    // Conciliación automática de los meses que toca el archivo: un solo candidato = conciliado.
    let conciliados = 0;
    let aRevisar = 0;
    let avisoConciliacion: string | null = null;
    const desde = lectura.periodo?.desde ?? "";
    const hasta = lectura.periodo?.hasta ?? "";
    for (const mes of desde ? mesesEntre(desde, hasta) : []) {
      const datos = await cargarMes(supabase, mes);
      if ("error" in datos) { avisoConciliacion = datos.error; break; }
      const c = await conciliarDatos(supabase, datos);
      if (!c.ok) { avisoConciliacion = c.message; break; }
      conciliados += c.data.conciliados;
      aRevisar += c.data.revisar;
    }
    setMensaje(
      `Importado: ${r.data.nuevos} movimientos nuevos y ${r.data.duplicados} que ya estaban.` +
        (avisoConciliacion ? ` No se pudo conciliar: ${avisoConciliacion}` : ` Conciliados con el ERP: ${conciliados}; por revisar: ${aRevisar}.`),
    );
    setLectura(null);
    setArchivo(null);
    setImportando(false);
    onImportado((desde || new Date().toISOString()).slice(0, 7));
  }

  const resumen = lectura?.resumen;
  return (
    <div className="space-y-3">
      <div className="gdrop">
        <p className="text-sm">
          <strong>Sube el estado de cuenta de la Caja Ica</strong> (el .xls que baja del banco). Se lee aquí mismo; no se envía hasta que confirmes.
        </p>
        <input ref={entrada} type="file" accept=".xls,.xlsx" className="sr-only" aria-label="Archivo del estado de cuenta" onChange={elegido} />
        <button type="button" className="gbtn" disabled={leyendo || importando} onClick={() => entrada.current?.click()}>
          {leyendo ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} Elegir archivo
        </button>
      </div>

      {error && <Aviso tipo="error">{error}</Aviso>}
      {mensaje && <Aviso tipo="ok">{mensaje}</Aviso>}

      {lectura && resumen && (
        <div className="gitem space-y-3">
          <div>
            <p className="font-semibold">{archivo}</p>
            <p className="text-sm" style={{ color: "var(--ink-3)" }}>
              {lectura.movimientos.length} movimientos del {lectura.periodo?.desde} al {lectura.periodo?.hasta}
              {lectura.cuenta ? ` · cuenta ${lectura.cuenta}` : ""}
            </p>
          </div>
          <ul className="grid gap-2 text-sm sm:grid-cols-2 md:grid-cols-3">
            <li><strong>Abonos:</strong> {dinero(resumen.abonos, "PEN")}</li>
            {(["convenio", "interbancaria", "app", "efectivo", "otro"] as const).map((t) => (
              <li key={t}>{ETIQUETA_TIPO[t]}: {resumen.porTipo[t].n} · {dinero(resumen.porTipo[t].monto, "PEN")}</li>
            ))}
            <li>Comisiones: {resumen.comisiones.n} · {dinero(resumen.comisiones.monto, "PEN")}</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="gbtn" disabled={importando} onClick={importar}>
              {importando && <Loader2 size={16} className="animate-spin" />} Importar y conciliar
            </button>
            <button type="button" className="gbtn-line" disabled={importando} onClick={() => { setLectura(null); setArchivo(null); }}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
