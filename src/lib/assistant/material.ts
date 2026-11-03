// ============================================================
// El material de los proyectos que el agente de WhatsApp puede enviar.
//
// El archivo sale siempre del catálogo de la app: el modelo pide un proyecto
// y un tipo, nunca una dirección, así que no puede mandar nada que no sea
// material oficial. Lo que WhatsApp no acepta por su peso va como enlace.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { whatsappWindowOpen } from "@/lib/client-portal/identity";
import type { ProyectoDeGolden } from "@/lib/golden/catalogo";

export const TIPOS_DE_MATERIAL = ["brochure", "video", "foto"] as const;
export type TipoDeMaterial = (typeof TIPOS_DE_MATERIAL)[number];

export interface AdjuntoMaterial {
  tipo: TipoDeMaterial;
  kind: "document" | "video" | "image";
  url: string;
  /** Nombre con el que le llega el PDF. */
  nombre: string;
  etiqueta: string;
  comoEnlace: boolean;
}

/** Lo que el dueño tiene que confirmar antes de que le llegue a un cliente. */
export interface EnvioPropuesto {
  id: string;
  cliente: string;
  telefono: string | null;
  asesor: string | null;
  etiquetas: string[];
  mensaje: string | null;
}

/** Lo que se guarda en `whatsapp_team_drafts.command`. */
export interface ComandoDeEnvio {
  tipo: "envio_cliente";
  conversacionId: string;
  canal: string;
  adjuntos: AdjuntoMaterial[];
  mensaje: string | null;
}

const MB = 1024 * 1024;
const COMO: Record<TipoDeMaterial, { kind: AdjuntoMaterial["kind"]; tope: number; titulo: string; extension: string }> = {
  brochure: { kind: "document", tope: 16 * MB, titulo: "Brochure", extension: ".pdf" },
  video: { kind: "video", tope: 16 * MB, titulo: "Video", extension: ".mp4" },
  foto: { kind: "image", tope: 5 * MB, titulo: "Foto", extension: ".jpg" },
};

const nombreDe = (p: ProyectoDeGolden) => p.nombreCorto || p.nombre;
const sinTildes = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

export function elegirMaterial(p: ProyectoDeGolden, tipo: TipoDeMaterial, baseUrl: string): AdjuntoMaterial | null {
  const archivo = p.media?.[tipo];
  if (!archivo) return null;
  const como = COMO[tipo];
  return {
    tipo,
    kind: como.kind,
    url: `${baseUrl.replace(/\/+$/, "")}${encodeURI(archivo.ruta)}`,
    nombre: `${como.titulo} ${nombreDe(p)}${como.extension}`,
    etiqueta: `${como.titulo} de ${nombreDe(p)}`,
    comoEnlace: archivo.bytes > como.tope,
  };
}

/** Qué material tiene un proyecto, para responder cuando piden lo que no hay. */
export function materialDisponible(p: ProyectoDeGolden): TipoDeMaterial[] {
  return TIPOS_DE_MATERIAL.filter((t) => p.media?.[t]);
}

export function buscarProyecto(
  proyectos: ProyectoDeGolden[],
  texto: string,
): { uno?: ProyectoDeGolden; varios?: ProyectoDeGolden[] } {
  const q = sinTildes(texto);
  const exacto = proyectos.find((p) => [p.id, p.nombre, p.nombreCorto ?? ""].some((n) => sinTildes(n) === q));
  if (exacto) return { uno: exacto };
  const parecidos = proyectos.filter((p) => sinTildes(`${p.nombre} ${p.nombreCorto ?? ""}`).includes(q));
  if (parecidos.length === 1) return { uno: parecidos[0] };
  return { varios: parecidos.length ? parecidos : proyectos };
}

/**
 * ¿Se le puede escribir ahora? WhatsApp sólo deja texto y archivos libres en
 * las 24 h siguientes al último mensaje del cliente; fuera de eso Meta acepta
 * el envío y lo rechaza después, y el dueño creería que le llegó. Los otros
 * canales siguen su propio camino al enviar.
 */
export async function ventanaDelCliente(
  db: SupabaseClient,
  conversacionId: string,
  canal: string,
): Promise<{ abierta: boolean; ultimoMensaje: string | null }> {
  if (canal !== "whatsapp") return { abierta: true, ultimoMensaje: null };
  const { data } = await db
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversacionId)
    .eq("sender_type", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ultimoMensaje = (data?.created_at as string | undefined) ?? null;
  return { abierta: whatsappWindowOpen(ultimoMensaje), ultimoMensaje };
}
