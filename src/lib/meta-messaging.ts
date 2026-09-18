// ============================================================
// Messenger e Instagram: recibir y contestar (053).
//
// Las dos redes usan la misma API de Meta ("Send API") con el token de la
// página conectada en 037. La diferencia es de dónde viene el mensaje:
//   · Messenger → el webhook trae `object: 'page'` y el id de la página.
//   · Instagram → trae `object: 'instagram'` y el id de la cuenta de IG,
//     que se busca en `meta_pages.instagram_id`.
//
// Quien escribe no tiene celular: se lo reconoce por su id en esa red
// (`contacts.messenger_psid` / `contacts.instagram_id`).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt } from "@/lib/whatsapp/encryption";
import { insertarMensaje, actualizarConversacion, type Canal } from "@/lib/channels";
import { notifyConversation } from "@/lib/push/send";

const GRAPH = "https://graph.facebook.com/v21.0";

export type CanalMeta = Extract<Canal, "messenger" | "instagram">;

export interface EventoMensaje {
  canal: CanalMeta;
  /** Página (Messenger) o cuenta de Instagram que recibió el mensaje. */
  destinoId: string;
  remitenteId: string;
  mid: string;
  texto: string | null;
  adjunto: { tipo: string; url: string } | null;
  cuando: number;
}

interface Pagina {
  account_id: string;
  page_id: string;
  page_access_token: string | null;
  is_active: boolean;
}

/** Saca los mensajes de una entrega del webhook de Meta (Messenger o Instagram). */
export function eventosDeMensajes(body: {
  object?: string;
  entry?: { id?: string; messaging?: unknown[] }[];
}): EventoMensaje[] {
  const canal: CanalMeta | null = body?.object === "page" ? "messenger" : body?.object === "instagram" ? "instagram" : null;
  if (!canal || !Array.isArray(body.entry)) return [];
  const out: EventoMensaje[] = [];
  for (const entry of body.entry) {
    for (const raw of entry.messaging ?? []) {
      const ev = raw as {
        sender?: { id?: string };
        recipient?: { id?: string };
        timestamp?: number;
        message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: { type?: string; payload?: { url?: string } }[] };
      };
      // Los "echo" son nuestras propias respuestas que Meta nos devuelve.
      if (!ev.message || ev.message.is_echo || !ev.sender?.id || !ev.message.mid) continue;
      const a = ev.message.attachments?.[0];
      out.push({
        canal,
        destinoId: entry.id ?? ev.recipient?.id ?? "",
        remitenteId: ev.sender.id,
        mid: ev.message.mid,
        texto: ev.message.text ?? null,
        adjunto: a?.payload?.url ? { tipo: a.type ?? "file", url: a.payload.url } : null,
        cuando: ev.timestamp ?? Date.now(),
      });
    }
  }
  return out;
}

async function paginaDe(db: SupabaseClient, canal: CanalMeta, destinoId: string): Promise<Pagina | null> {
  const { data } = await db
    .from("meta_pages")
    .select("account_id, page_id, page_access_token, is_active")
    .eq(canal === "messenger" ? "page_id" : "instagram_id", destinoId)
    .maybeSingle();
  return (data as Pagina | null) ?? null;
}

async function nombreEnMeta(canal: CanalMeta, id: string, token: string): Promise<string | null> {
  const campos = canal === "messenger" ? "first_name,last_name" : "name,username";
  try {
    const res = await fetch(`${GRAPH}/${id}?fields=${campos}&access_token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { first_name?: string; last_name?: string; name?: string; username?: string };
    return [j.first_name, j.last_name].filter(Boolean).join(" ") || j.name || (j.username ? `@${j.username}` : null);
  } catch {
    return null;
  }
}

const TIPO_ADJUNTO: Record<string, string> = { image: "image", video: "video", audio: "audio", file: "document" };

/** Guarda un mensaje entrante de Messenger o Instagram en su conversación. */
export async function recibirMensajeMeta(db: SupabaseClient, ev: EventoMensaje): Promise<void> {
  const pagina = await paginaDe(db, ev.canal, ev.destinoId);
  if (!pagina || !pagina.is_active) {
    console.info(`[meta messaging] ${ev.canal} ${ev.destinoId} no está conectada o está pausada`);
    return;
  }
  const token = pagina.page_access_token ? decrypt(pagina.page_access_token) : null;

  const { data: cuenta } = await db.from("accounts").select("owner_user_id").eq("id", pagina.account_id).maybeSingle();
  if (!cuenta?.owner_user_id) return;

  // El mismo mensaje puede llegar dos veces (reintentos de Meta).
  const { data: repetido } = await db.from("messages").select("id").eq("message_id", ev.mid).limit(1);
  if (repetido?.length) return;

  const columna = ev.canal === "messenger" ? "messenger_psid" : "instagram_id";
  let { data: contacto } = await db
    .from("contacts")
    .select("id, name")
    .eq("account_id", pagina.account_id)
    .eq(columna, ev.remitenteId)
    .maybeSingle();

  if (!contacto) {
    const nombre = (token && (await nombreEnMeta(ev.canal, ev.remitenteId, token))) || (ev.canal === "messenger" ? "Cliente de Messenger" : "Cliente de Instagram");
    const { data: nuevo, error } = await db
      .from("contacts")
      .insert({
        account_id: pagina.account_id,
        user_id: cuenta.owner_user_id,
        phone: "",
        name: nombre,
        [columna]: ev.remitenteId,
        lead_source: ev.canal === "messenger" ? "facebook" : "instagram",
      })
      .select("id, name")
      .single();
    if (error) {
      // Carrera con otra entrega: el índice único ya lo tiene.
      const { data: otra } = await db.from("contacts").select("id, name").eq("account_id", pagina.account_id).eq(columna, ev.remitenteId).maybeSingle();
      if (!otra) {
        console.error("[meta messaging] could not create contact:", error.message);
        return;
      }
      contacto = otra;
    } else {
      contacto = nuevo;
    }
  }
  if (!contacto) return;

  let { data: conv } = await db
    .from("conversations")
    .select("id, unread_count, assigned_agent_id")
    .eq("account_id", pagina.account_id)
    .eq("contact_id", contacto.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) {
    const { data: nueva, error } = await db
      .from("conversations")
      .insert({ account_id: pagina.account_id, user_id: cuenta.owner_user_id, contact_id: contacto.id })
      .select("id, unread_count, assigned_agent_id")
      .single();
    if (error || !nueva) {
      console.error("[meta messaging] could not open conversation:", error?.message);
      return;
    }
    conv = nueva;
  }
  if (!conv) return;

  const tipo = ev.adjunto ? TIPO_ADJUNTO[ev.adjunto.tipo] ?? "document" : "text";
  await insertarMensaje(db, {
    conversation_id: conv.id,
    sender_type: "customer",
    content_type: tipo,
    content_text: ev.texto,
    media_url: ev.adjunto?.url ?? null,
    message_id: ev.mid,
    status: "delivered",
    created_at: new Date(ev.cuando).toISOString(),
    channel: ev.canal,
  }, "id");

  const resumen = ev.texto || (tipo === "image" ? "📷 Foto" : "📎 Adjunto");
  await actualizarConversacion(
    db,
    conv.id,
    {
      last_message_text: resumen,
      last_message_at: new Date().toISOString(),
      unread_count: (conv.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
      status: "open",
    },
    ev.canal,
  );

  await notifyConversation(db, {
    accountId: pagina.account_id,
    conversationId: conv.id,
    assignedAgentId: conv.assigned_agent_id ?? null,
    title: `${contacto.name || "Cliente"} · ${ev.canal === "messenger" ? "Messenger" : "Instagram"}`,
    body: resumen,
  }).catch(() => {});
}

/**
 * Contesta por Messenger o Instagram con el token de la página. Devuelve
 * el `mid` que da Meta. Lanza con el mensaje de Meta si lo rechaza (por
 * ejemplo, pasadas las 24 h desde el último mensaje del cliente).
 */
export async function enviarPorMeta(
  db: SupabaseClient,
  args: {
    accountId: string;
    canal: CanalMeta;
    destinatarioId: string;
    texto?: string | null;
    adjunto?: { tipo: string; url: string } | null;
  },
): Promise<string> {
  const { data: paginas } = await db
    .from("meta_pages")
    .select("page_id, page_access_token, instagram_id, is_active")
    .eq("account_id", args.accountId)
    .eq("is_active", true);
  const pagina = (paginas ?? []).find((p) => (args.canal === "instagram" ? p.instagram_id : true) && p.page_access_token);
  if (!pagina?.page_access_token) throw new Error(`${args.canal === "messenger" ? "Messenger" : "Instagram"} no está conectado.`);
  const token = decrypt(pagina.page_access_token as string);

  const mensaje = args.adjunto
    ? {
        attachment: {
          type: args.adjunto.tipo === "image" ? "image" : args.adjunto.tipo === "video" ? "video" : args.adjunto.tipo === "audio" ? "audio" : "file",
          payload: { url: args.adjunto.url, is_reusable: true },
        },
      }
    : { text: args.texto ?? "" };

  const res = await fetch(`${GRAPH}/${pagina.page_id}/messages?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: args.destinatarioId }, messaging_type: "RESPONSE", message: mensaje }),
  });
  const j = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
  if (!res.ok || j.error) throw new Error(j.error?.message ?? `Meta respondió ${res.status}`);

  // Un adjunto con texto sale en dos mensajes: Meta no admite pie de foto.
  if (args.adjunto && args.texto) {
    await fetch(`${GRAPH}/${pagina.page_id}/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: args.destinatarioId }, messaging_type: "RESPONSE", message: { text: args.texto } }),
    }).catch(() => {});
  }
  return j.message_id ?? "";
}

/** El id del contacto en esa red, si lo tiene. */
export function idEnRed(contacto: { messenger_psid?: string | null; instagram_id?: string | null }, canal: CanalMeta): string | null {
  return (canal === "messenger" ? contacto.messenger_psid : contacto.instagram_id) ?? null;
}
