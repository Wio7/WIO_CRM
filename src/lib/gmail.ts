// ============================================================
// Gmail en la bandeja (054).
//
// Conexión: OAuth de Google con los permisos justos para leer lo que
// llega (gmail.readonly), contestar (gmail.send) y saber qué buzón es
// (userinfo.email). Se guarda el refresh token cifrado; cada pasada del
// cron pide un access token nuevo con él.
//
// Lectura: la primera vez, lo que llegó en los últimos 2 días a la
// bandeja de entrada; después, sólo lo nuevo desde el último history_id.
// Cada correo entra en la conversación del remitente (por su email) con
// canal 'correo'. Se ignoran los que manda el propio buzón y las
// notificaciones automáticas (no-reply, promociones, redes sociales).
//
// Envío: un correo de texto en el mismo hilo (threadId + In-Reply-To),
// desde el buzón conectado.
//
// Variables: GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (Google Cloud →
// Credenciales → ID de cliente OAuth, tipo "Aplicación web").
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";
import { insertarMensaje, actualizarConversacion } from "@/lib/channels";
import { notifyConversation } from "@/lib/push/send";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function hayGoogle(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function urlDeAutorizacion(state: string, redirectUri: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    // Sin esto, Google sólo da refresh token la primera vez.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function pedirToken(cuerpo: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      ...cuerpo,
    }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `Google respondió ${res.status}`);
  return j;
}

export async function canjearCodigo(code: string, redirectUri: string) {
  const t = await pedirToken({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  const yo = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${t.access_token}` },
  }).then((r) => r.json() as Promise<{ email?: string }>);
  if (!t.refresh_token) throw new Error("Google no entregó permiso permanente. Quita el acceso de la app en tu cuenta de Google y vuelve a conectar.");
  if (!yo.email) throw new Error("No se pudo saber qué buzón es.");
  return { refreshToken: t.refresh_token, email: yo.email.toLowerCase() };
}

async function tokenDeAcceso(refreshCifrado: string): Promise<string> {
  const t = await pedirToken({ refresh_token: decrypt(refreshCifrado), grant_type: "refresh_token" });
  return t.access_token as string;
}

async function gmail<T>(token: string, ruta: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${ruta}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok) {
    const e = new Error(j.error?.message || `Gmail respondió ${res.status}`) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return j;
}

// ------------------------------------------------------------
// Lectura
// ------------------------------------------------------------

interface Parte {
  mimeType?: string;
  body?: { data?: string };
  parts?: Parte[];
}

interface MensajeGmail {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: Parte & { headers?: { name: string; value: string }[] };
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");

function textoPlano(p?: Parte): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return b64(p.body.data);
  for (const hijo of p.parts ?? []) {
    const t = textoPlano(hijo);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data) {
    return b64(p.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  }
  for (const hijo of p.parts ?? []) {
    if (hijo.mimeType === "text/html" && hijo.body?.data) return textoPlano(hijo);
  }
  return "";
}

/** Corta lo citado ("El lun, X escribió:" y las líneas con ">"): en la bandeja basta lo nuevo. */
function sinCita(texto: string): string {
  const lineas = texto.replace(/\r/g, "").split("\n");
  const fin = lineas.findIndex((l) => /^(El .+ escribió:|On .+ wrote:)$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  const util = (fin >= 0 ? lineas.slice(0, fin) : lineas).filter((l) => !l.startsWith(">"));
  return util.join("\n").trim().slice(0, 4000);
}

const cabecera = (m: MensajeGmail, nombre: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === nombre.toLowerCase())?.value ?? "";

function remitente(valor: string): { nombre: string | null; email: string } | null {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(valor);
  const email = (m ? m[2] : valor).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  return { nombre: m?.[1]?.trim() || null, email };
}

const AUTOMATICO = /(no-?reply|noreply|mailer-daemon|notifications?@|notificaciones@|newsletter|bounce)/i;

async function guardarCorreo(
  db: SupabaseClient,
  cuenta: { account_id: string; email: string },
  duenoId: string,
  m: MensajeGmail,
): Promise<boolean> {
  if (m.labelIds?.some((l) => ["SENT", "DRAFT", "SPAM", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"].includes(l))) return false;
  const de = remitente(cabecera(m, "From"));
  if (!de || de.email === cuenta.email || AUTOMATICO.test(de.email)) return false;

  const { data: repetido } = await db.from("messages").select("id").eq("message_id", `gmail:${m.id}`).limit(1);
  if (repetido?.length) return false;

  let { data: contacto } = await db
    .from("contacts")
    .select("id, name")
    .eq("account_id", cuenta.account_id)
    .ilike("email", de.email)
    .limit(1)
    .maybeSingle();
  if (!contacto) {
    const { data: nuevo, error } = await db
      .from("contacts")
      .insert({
        account_id: cuenta.account_id,
        user_id: duenoId,
        phone: "",
        email: de.email,
        name: de.nombre || de.email,
        lead_source: "email",
      })
      .select("id, name")
      .single();
    if (error || !nuevo) {
      console.error("[gmail] could not create contact:", error?.message);
      return false;
    }
    contacto = nuevo;
  }
  if (!contacto) return false;

  let { data: conv } = await db
    .from("conversations")
    .select("id, unread_count, assigned_agent_id")
    .eq("account_id", cuenta.account_id)
    .eq("contact_id", contacto.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) {
    const { data: nueva, error } = await db
      .from("conversations")
      .insert({ account_id: cuenta.account_id, user_id: duenoId, contact_id: contacto.id })
      .select("id, unread_count, assigned_agent_id")
      .single();
    if (error || !nueva) return false;
    conv = nueva;
  }
  if (!conv) return false;

  const asunto = cabecera(m, "Subject").slice(0, 200);
  const cuerpo = sinCita(textoPlano(m.payload));
  const texto = [asunto ? `✉️ ${asunto}` : "", cuerpo].filter(Boolean).join("\n\n") || "(correo sin texto)";

  await insertarMensaje(db, {
    conversation_id: conv.id,
    sender_type: "customer",
    content_type: "text",
    content_text: texto,
    message_id: `gmail:${m.id}`,
    status: "delivered",
    created_at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString(),
    channel: "correo",
  }, "id");

  await actualizarConversacion(
    db,
    conv.id,
    {
      last_message_text: asunto || cuerpo.slice(0, 120),
      last_message_at: new Date().toISOString(),
      unread_count: (conv.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
      status: "open",
      email_thread_id: m.threadId,
      email_subject: asunto || null,
    },
    "correo",
  );

  await notifyConversation(db, {
    accountId: cuenta.account_id,
    conversationId: conv.id,
    assignedAgentId: conv.assigned_agent_id ?? null,
    title: `${contacto.name || de.email} · correo`,
    body: asunto || cuerpo.slice(0, 120),
  }).catch(() => {});
  return true;
}

/** Una pasada por cada buzón conectado. La llama el cron cada ~5 minutos. */
export async function sincronizarCorreos(db: SupabaseClient): Promise<{ nuevos: number; error?: string }> {
  if (!hayGoogle()) return { nuevos: 0 };
  const { data: cuentas, error } = await db
    .from("email_accounts")
    .select("account_id, email, refresh_token, history_id")
    .eq("is_active", true);
  if (error) return { nuevos: 0, error: error.message };

  let nuevos = 0;
  for (const c of cuentas ?? []) {
    try {
      const token = await tokenDeAcceso(c.refresh_token as string);
      const { data: cuenta } = await db.from("accounts").select("owner_user_id").eq("id", c.account_id).maybeSingle();
      if (!cuenta?.owner_user_id) continue;

      let ids: string[] = [];
      let historia: string | null = null;
      if (c.history_id) {
        try {
          const h = await gmail<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId?: string }>(
            token,
            `/history?startHistoryId=${c.history_id}&historyTypes=messageAdded&labelId=INBOX`,
          );
          ids = (h.history ?? []).flatMap((x) => (x.messagesAdded ?? []).map((a) => a.message.id));
          historia = h.historyId ?? c.history_id;
        } catch (err) {
          // 404: el history_id caducó (más de una semana sin leer). Se
          // vuelve a empezar por los últimos 2 días.
          if ((err as { status?: number }).status !== 404) throw err;
        }
      }
      if (!historia) {
        const l = await gmail<{ messages?: { id: string }[] }>(token, `/messages?q=${encodeURIComponent("in:inbox newer_than:2d")}&maxResults=25`);
        ids = (l.messages ?? []).map((x) => x.id);
        const perfil = await gmail<{ historyId?: string }>(token, "/profile");
        historia = perfil.historyId ?? null;
      }

      for (const id of [...new Set(ids)].slice(0, 50)) {
        const m = await gmail<MensajeGmail>(token, `/messages/${id}?format=full`);
        if (await guardarCorreo(db, { account_id: c.account_id as string, email: c.email as string }, cuenta.owner_user_id as string, m)) nuevos += 1;
      }

      await db
        .from("email_accounts")
        .update({ history_id: historia, last_sync_at: new Date().toISOString(), last_error: null })
        .eq("account_id", c.account_id);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message.slice(0, 300) : "error";
      console.error("[gmail] sync failed:", mensaje);
      await db.from("email_accounts").update({ last_error: mensaje }).eq("account_id", c.account_id);
    }
  }
  return { nuevos };
}

// ------------------------------------------------------------
// Envío
// ------------------------------------------------------------

/** Encabezado MIME con acentos (RFC 2047). */
const mimeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`);

export async function enviarCorreo(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; para: string; texto: string },
): Promise<string> {
  const { data: cuenta } = await db
    .from("email_accounts")
    .select("email, refresh_token")
    .eq("account_id", args.accountId)
    .eq("is_active", true)
    .maybeSingle();
  if (!cuenta) throw new Error("No hay un correo conectado.");
  const { data: conv } = await db
    .from("conversations")
    .select("email_thread_id, email_subject")
    .eq("id", args.conversationId)
    .maybeSingle();

  const token = await tokenDeAcceso(cuenta.refresh_token as string);
  const asunto = conv?.email_subject ? (/^re:/i.test(conv.email_subject) ? conv.email_subject : `Re: ${conv.email_subject}`) : "Golden Habitat";

  // Para que caiga en el mismo hilo, se cita el último correo recibido.
  let respondeA = "";
  if (conv?.email_thread_id) {
    try {
      const hilo = await gmail<{ messages?: MensajeGmail[] }>(token, `/threads/${conv.email_thread_id}?format=metadata&metadataHeaders=Message-ID`);
      const ultimo = hilo.messages?.[hilo.messages.length - 1];
      respondeA = ultimo ? cabecera(ultimo, "Message-ID") : "";
    } catch {
      /* sin hilo: sale como correo nuevo */
    }
  }

  const mime = [
    `From: ${cuenta.email}`,
    `To: ${args.para}`,
    `Subject: ${mimeWord(asunto)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    ...(respondeA ? [`In-Reply-To: ${respondeA}`, `References: ${respondeA}`] : []),
    "",
    args.texto,
  ].join("\r\n");

  const enviado = await gmail<{ id: string; threadId: string }>(token, "/messages/send", {
    method: "POST",
    body: JSON.stringify({
      raw: Buffer.from(mime, "utf-8").toString("base64url"),
      ...(conv?.email_thread_id ? { threadId: conv.email_thread_id } : {}),
    }),
  });

  if (!conv?.email_thread_id) {
    await db.from("conversations").update({ email_thread_id: enviado.threadId, email_subject: asunto }).eq("id", args.conversationId);
  }
  return `gmail:${enviado.id}`;
}

export { encrypt as cifrar };
