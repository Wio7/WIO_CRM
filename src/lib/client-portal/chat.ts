// ============================================================
// El chat del cliente, visto desde su lado.
//
// El cliente escribe dentro de la Golden App y NO sale a WhatsApp. Su
// mensaje entra en la MISMA conversación que el asesor atiende en la
// bandeja del CRM: no hay un "chat de la app" aparte que alguien tenga
// que revisar por separado. Cuando el número de WhatsApp esté conectado,
// lo que el cliente escriba por WhatsApp y lo que escriba en la app caen
// en el mismo hilo, en orden.
//
// Por eso un mensaje del cliente se guarda exactamente como lo guarda el
// webhook de WhatsApp (`sender_type = 'customer'`), con dos diferencias:
// no tiene `message_id` de Meta (no pasó por ahí) y su `status` es
// 'delivered' desde el principio.
//
// Todo corre con el service role y filtra SIEMPRE por el contacto de la
// sesión. Después de la 041 un cliente no es miembro de la cuenta, así
// que no hay política de la base que pueda abrirle otra conversación.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { notifyConversation } from "@/lib/push/send";
import { insertarMensaje, actualizarConversacion } from "@/lib/channels";

export interface MensajeChat {
  id: string;
  /** 'cliente' lo escribió él; 'golden' el asesor o la IA. */
  de: "cliente" | "golden";
  texto: string | null;
  tipo: string;
  media_url: string | null;
  enviado_el: string;
}

interface ContactoMinimo {
  id: string;
  account_id: string;
  name?: string | null;
  phone?: string | null;
}

/**
 * La conversación del contacto, o una nueva si nunca escribió.
 *
 * `user_id` es una columna heredada NOT NULL (001) que hoy sólo sirve de
 * auditoría: se rellena con el dueño de la cuenta, igual que hace el
 * webhook con el dueño de la configuración de WhatsApp.
 */
export async function conversacionDelCliente(
  db: SupabaseClient,
  contacto: ContactoMinimo,
  crearSiNoExiste = true,
): Promise<{ id: string; assigned_agent_id: string | null; unread_count: number } | null> {
  const { data: existente } = await db
    .from("conversations")
    .select("id, assigned_agent_id, unread_count")
    .eq("contact_id", contacto.id)
    .eq("account_id", contacto.account_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existente) {
    return existente as { id: string; assigned_agent_id: string | null; unread_count: number };
  }
  if (!crearSiNoExiste) return null;

  const { data: cuenta } = await db
    .from("accounts")
    .select("owner_user_id")
    .eq("id", contacto.account_id)
    .maybeSingle();

  const { data: creada, error } = await db
    .from("conversations")
    .insert({
      account_id: contacto.account_id,
      contact_id: contacto.id,
      user_id: cuenta?.owner_user_id ?? null,
      status: "open",
      assigned_agent_id: await aQuienLeToca(db, contacto),
    })
    .select("id, assigned_agent_id, unread_count")
    .single();

  if (error) {
    console.error("[client-portal] could not open the conversation:", error.message);
    return null;
  }
  return creada as { id: string; assigned_agent_id: string | null; unread_count: number };
}

/**
 * A quién le toca este cliente.
 *
 * En Golden el asesor vende y suelta: al que ya está pagando lo lleva
 * COBRANZAS, no quien se lo vendió. Así que si el contacto tiene plan de
 * cuotas, la conversación nace asignada al de cobranzas menos cargado
 * (función `pick_area_agent`, migración 048).
 *
 * `null` significa "que decida el reparto de siempre": es lo que pasa con
 * quien todavía no compró —ése es de ventas— y también cuando nadie tiene
 * todavía el cargo de cobranzas, porque dejar la conversación sin dueño
 * es mejor que asignársela a alguien que no la va a atender.
 */
async function aQuienLeToca(
  db: SupabaseClient,
  contacto: ContactoMinimo,
): Promise<string | null> {
  const { count, error } = await db
    .from("payment_plans")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contacto.id)
    .in("status", ["activo", "pagado"]);
  if (error || !count) return null;

  const { data, error: errArea } = await db.rpc("pick_area_agent", {
    p_account_id: contacto.account_id,
    p_area: "cobranzas",
  });
  if (errArea) {
    // Sin 048 aplicada la función no existe: seguir sin asignar es
    // correcto, el reparto de 039 hace lo suyo.
    console.error("[client-portal] pick_area_agent failed:", errArea.message);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Los mensajes del hilo, del más viejo al más nuevo. `desde` permite
 * pedir sólo lo nuevo, que es lo que hace la app cada pocos segundos
 * mientras el cliente tiene el chat abierto.
 */
export async function mensajesDelCliente(
  db: SupabaseClient,
  conversationId: string,
  desde?: string,
  limite = 80,
): Promise<MensajeChat[]> {
  let q = db
    .from("messages")
    .select("id, sender_type, content_type, content_text, media_url, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limite);
  if (desde) q = q.gt("created_at", desde);

  const { data, error } = await q;
  if (error) {
    console.error("[client-portal] messages lookup failed:", error.message);
    return [];
  }

  return (data ?? [])
    .map((m) => ({
      id: m.id as string,
      // 'bot' es la IA del CRM: para el cliente también es Golden.
      de: (m.sender_type === "customer" ? "cliente" : "golden") as MensajeChat["de"],
      texto: (m.content_text as string) ?? null,
      tipo: (m.content_type as string) ?? "text",
      media_url: (m.media_url as string) ?? null,
      enviado_el: m.created_at as string,
    }))
    .reverse();
}

/**
 * Guarda lo que escribió el cliente y despierta a su asesor.
 *
 * El aviso se manda siempre que se pueda, pero un fallo de push nunca
 * tumba el mensaje: para el cliente, escribir tiene que funcionar aunque
 * nadie esté mirando del otro lado.
 */
export async function guardarMensajeDelCliente(
  db: SupabaseClient,
  contacto: ContactoMinimo,
  texto: string,
  adjunto?: { tipo: "image" | "document"; url: string },
): Promise<MensajeChat | null> {
  const conv = await conversacionDelCliente(db, contacto);
  if (!conv) return null;

  const { data: guardado, error } = await insertarMensaje<{ id: string; created_at: string }>(
    db,
    {
      conversation_id: conv.id,
      sender_type: "customer",
      content_type: adjunto?.tipo ?? "text",
      content_text: texto || null,
      media_url: adjunto?.url ?? null,
      status: "delivered",
      channel: "app",
    },
    "id, created_at",
  );

  if (error || !guardado) {
    console.error("[client-portal] could not save the message:", error?.message);
    return null;
  }

  // El cliente escribió por la app: por la app se le contesta.
  await actualizarConversacion(
    db,
    conv.id,
    {
      last_message_text: adjunto ? (adjunto.tipo === "image" ? "📷 Foto" : "📄 Documento") : texto,
      last_message_at: new Date().toISOString(),
      unread_count: (conv.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    },
    "app",
  );

  try {
    await notifyConversation(db, {
      accountId: contacto.account_id,
      conversationId: conv.id,
      assignedAgentId: conv.assigned_agent_id ?? null,
      title: contacto.name || contacto.phone || "Cliente",
      body: adjunto
        ? `${adjunto.tipo === "image" ? "📷 Foto" : "📄 Documento"}${texto ? `: ${texto}` : ""}`
        : texto,
    });
  } catch (err) {
    console.error("[client-portal] push notify failed:", err);
  }

  return {
    id: guardado.id as string,
    de: "cliente",
    texto: texto || null,
    tipo: adjunto?.tipo ?? "text",
    media_url: adjunto?.url ?? null,
    enviado_el: guardado.created_at as string,
  };
}
