import { MODULE_AREAS, MODULES, isModuleVisible, type ModuleArea } from "@/lib/modules";
import type { Tone } from "@/lib/tones";

export const AREA_TONE: Record<ModuleArea, Tone> = {
  comunicacion: "sky",
  ventas: "emerald",
  finanzas: "amber",
  agenda: "violet",
  automatizacion: "rose",
};

/** Nombres cortos para la barra inferior. */
export const TAB_LABEL: Record<string, string> = {
  "/dashboard": "Inicio",
  "/inbox": "Chats",
  "/contacts": "Clientes",
  "/pipelines": "Ventas",
  "/calendar": "Agenda",
  "/broadcasts": "Campañas",
  "/store": "Tienda",
  "/collections": "Cobros",
  "/caja": "Caja",
};

const PRIORITY = Object.keys(TAB_LABEL).slice(1);
type Access = Parameters<typeof isModuleVisible>[2];

/** Inicio + las 3 secciones más usadas que la cuenta tiene encendidas. */
export function mobileTabs(disabled: string[] | undefined, access: Access): string[] {
  return ["/dashboard", ...PRIORITY.filter((h) => isModuleVisible(h, disabled, access)).slice(0, 3)];
}

/** Módulos encendidos, agrupados por área (áreas vacías no salen). */
export function visibleAreas(disabled: string[] | undefined, access: Access) {
  return MODULE_AREAS.map((a) => ({
    ...a,
    tone: AREA_TONE[a.key],
    hrefs: MODULES.filter((m) => m.area === a.key && isModuleVisible(m.href, disabled, access)).map((m) => m.href),
  })).filter((a) => a.hrefs.length > 0);
}
