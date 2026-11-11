// A dónde lleva cada área de un negocio: su módulo en el ERP y su app web.
// Puro y con pruebas. Lo usan la vista Cuentas del super admin y la del dueño
// (mismo árbol). No toca src/lib/apps: solo reusa appDeArea y nombreApp.

import { appDeArea } from "@/lib/apps/acceso";
import { nombreApp } from "@/lib/apps/nombres";
import { cajaMenuLabel } from "@/lib/cash/menu";
import { isModuleDisabled } from "@/lib/modules";
import type { AccountRole } from "@/lib/auth/roles";

export const AREA_KEYS = [
  "gerencia",
  "ventas",
  "legal",
  "cobranzas",
  "contabilidad",
  "marketing",
  "tecnica",
  "sin_area",
] as const;

export type AreaKey = (typeof AREA_KEYS)[number];
export type RamaKey = AreaKey | "tienda";

export const AREA_LABEL: Record<RamaKey, string> = {
  gerencia: "Gerencia",
  ventas: "Ventas",
  legal: "Legal",
  cobranzas: "Cobranzas",
  contabilidad: "Contabilidad",
  marketing: "Marketing",
  tecnica: "Área técnica",
  sin_area: "Sin área",
  tienda: "Tienda",
};

/** Lo mínimo de una cuenta que hace falta para armar destinos. */
export interface CuentaDestino {
  name: string;
  brand_name?: string | null;
  disabled_modules?: string[] | null;
}

export interface AppDestino {
  nombre: string;
  /** Link absoluto (o ruta interna si no se pasó el origen). Sirve para instalarla en el celular. */
  url: string;
}

export interface Destino {
  key: RamaKey;
  label: string;
  /** Ruta del módulo en el ERP, dentro de la misma cuenta. */
  erpHref: string;
  /** null = el área todavía no tiene app ("App en camino"). */
  app: AppDestino | null;
  /** Encendida o apagada según accounts.disabled_modules. */
  estado: "activa" | "apagada";
}

const GOLDEN_VENTAS_URL = "https://golden.wiocompany.com";
const GOLDEN_LEGAL_URL = "https://golden-legal.vercel.app";
const VITA_LIFE_URL = "https://vita-life-amber.vercel.app";

const esGolden = (c: CuentaDestino) => /golden/i.test(c.name) || /golden/i.test(c.brand_name ?? "");
const esVitaLife = (c: CuentaDestino) => /vita life/i.test(c.name) || /vita life/i.test(c.brand_name ?? "");

/** App interna del repo (ruta) con el origen actual, o la ruta suelta si no hay origen. */
const interna = (nombre: string, ruta: string, origen?: string): AppDestino => ({
  nombre,
  url: origen ? `${origen.replace(/\/$/, "")}${ruta}` : ruta,
});

export function destinoDeArea(area: AreaKey, cuenta: CuentaDestino, origen?: string): Destino {
  const off = cuenta.disabled_modules ?? [];
  const apagado = (href: string) => isModuleDisabled(href, off);
  const base = { key: area, label: AREA_LABEL[area] };
  const estadoDe = (href: string): Destino["estado"] => (apagado(href) ? "apagada" : "activa");
  const golden = esGolden(cuenta);

  switch (area) {
    case "ventas": {
      const erpHref = apagado("/contacts") && !apagado("/pipelines") ? "/pipelines" : "/contacts";
      return {
        ...base,
        erpHref,
        estado: estadoDe(erpHref),
        app: golden ? { nombre: "Golden App (ventas)", url: GOLDEN_VENTAS_URL } : null,
      };
    }
    case "legal":
      return {
        ...base,
        erpHref: "/payment-plans",
        estado: estadoDe("/payment-plans"),
        app: golden ? { nombre: "Golden Legal", url: GOLDEN_LEGAL_URL } : null,
      };
    case "cobranzas": {
      const app = appDeArea("cobranzas");
      return {
        ...base,
        erpHref: "/collections",
        estado: estadoDe("/collections"),
        app: app ? interna(nombreApp("cobranzas", cuenta.name, cuenta.brand_name), app.ruta, origen) : null,
      };
    }
    case "contabilidad": {
      const app = appDeArea("contabilidad");
      return {
        ...base,
        erpHref: "/payment-plans",
        estado: estadoDe("/payment-plans"),
        app: app ? interna(cajaMenuLabel(cuenta.name, cuenta.brand_name), app.ruta, origen) : null,
      };
    }
    case "marketing":
    case "gerencia":
    case "tecnica": {
      // Su app se activa sola cuando aparece en EXISTENTES de acceso.ts.
      const propia = appDeArea(area);
      const erpHref = area === "marketing" ? "/broadcasts" : "/dashboard";
      return {
        ...base,
        erpHref,
        estado: estadoDe(erpHref),
        app: propia && propia.key === area ? interna(nombreApp(area, cuenta.name, cuenta.brand_name), propia.ruta, origen) : null,
      };
    }
    case "sin_area":
      return { ...base, erpHref: "/dashboard", estado: "activa", app: null };
  }
}

/** Rama "Tienda": solo si el módulo /store está encendido. App solo para Vita Life. */
export function tiendaDeCuenta(cuenta: CuentaDestino): Destino | null {
  if (isModuleDisabled("/store", cuenta.disabled_modules ?? [])) return null;
  return {
    key: "tienda",
    label: AREA_LABEL.tienda,
    erpHref: "/store",
    estado: "activa",
    app: esVitaLife(cuenta) ? { nombre: "Tienda", url: VITA_LIFE_URL } : null,
  };
}

/** Quién ve "Cuentas" en su propio negocio: el dueño y la gente de Gerencia. */
export function puedeVerCuentas(who: { role: AccountRole | string | null; area: string | null }): boolean {
  if (!who.role) return false; // sin cuenta no hay nada que mostrar
  return who.role === "owner" || who.area === "gerencia";
}
