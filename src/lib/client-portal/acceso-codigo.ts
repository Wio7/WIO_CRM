// ============================================================
// Entrar a la app con un código por WhatsApp (061).
//
// Para el contacto que ya está en el CRM sin DNI —casi siempre alguien
// que llegó de un anuncio y escribió por WhatsApp—. El registro normal no
// puede darle esa ficha: con sólo saber su número, cualquiera vería su
// chat. Aquí demuestra que el número es suyo recibiendo un código en ese
// mismo WhatsApp; al escribirlo, su DNI queda en la ficha que ya tenía y
// entra con su misma conversación, su asesor y su historial.
//
// El código sólo sale por texto libre, dentro de la ventana de 24 h de
// WhatsApp. Si está cerrada se le pide que escriba primero: su mensaje la
// reabre y no hace falta plantilla.
//
// Siempre con el service role: client_access_codes no tiene políticas.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { faltaColumnaCanal } from "@/lib/channels";
import { sendTextMessage } from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getPrimaryLine } from "@/lib/whatsapp/lines";
import {
  isRecipientNotAllowedError,
  phoneVariants,
  sanitizePhoneForMeta,
} from "@/lib/whatsapp/phone-utils";
import {
  ACCESS_CODE_TTL_MS,
  CODES_WINDOW_MS,
  IP_WINDOW_MS,
  MAX_CODE_TRIES,
  PHONE_WINDOW_MS,
  SESSION_TTL_MS,
  codeCooldownMs,
  hashAccessCode,
  hashSessionToken,
  ipLockedUntil,
  maskPhone,
  newAccessCode,
  newSessionToken,
  normalizeAccessCode,
  normalizeDni,
  phoneCandidates,
  phoneKey,
  phoneLockedUntil,
  sameSecret,
  whatsappWindowOpen,
} from "./identity";
import {
  cuentaDeRegistro,
  resumenConTipo,
  type ContactRow,
  type SignInResult,
} from "./sessions";

const since = (ms: number) => new Date(Date.now() - ms).toISOString();

export type PedirCodigoResult =
  | { ok: true; phone_hint: string; expires_in_seconds: number }
  | {
      ok: false;
      reason:
        | "invalid_input"
        | "sin_cuenta"
        | "no_existe"
        | "ya_existe"
        | "fuera_de_ventana"
        | "server_error";
    }
  | { ok: false; reason: "locked" | "espera"; retry_after_seconds: number };

/**
 * Manda un código al WhatsApp del contacto que tiene ese celular y
 * todavía no tiene DNI.
 */
export async function pedirCodigoDeAcceso(
  db: SupabaseClient,
  input: { phone: string; ip: string },
): Promise<PedirCodigoResult> {
  const candidates = phoneCandidates(input.phone);
  if (!candidates.length) return { ok: false, reason: "invalid_input" };
  const key = phoneKey(input.phone);

  const cuenta = await cuentaDeRegistro(db);
  if (!cuenta) return { ok: false, reason: "sin_cuenta" };

  const bloqueo = await bloqueoPorIp(db, input.ip);
  if (bloqueo) return { ok: false, reason: "locked", retry_after_seconds: bloqueo };

  const { data: contactos, error } = await db
    .from("contacts")
    .select("id, account_id, name, phone, dni")
    .eq("account_id", cuenta.id)
    .in("phone_normalized", candidates)
    .limit(1);
  if (error) {
    console.error("[client-portal] code: contact lookup failed:", error);
    return { ok: false, reason: "server_error" };
  }
  const contacto = contactos?.[0];
  // Sin ficha: que se registre normal. Con DNI: que entre con él. Ninguno
  // de los dos recibe código, así el formulario no manda WhatsApps a
  // números que no nos escribieron.
  if (!contacto) return { ok: false, reason: "no_existe" };
  if (contacto.dni) return { ok: false, reason: "ya_existe" };

  const { data: previos } = await db
    .from("client_access_codes")
    .select("created_at")
    .eq("phone_digits", key)
    .gte("created_at", since(CODES_WINDOW_MS))
    .order("created_at", { ascending: false })
    .limit(10);
  const espera = codeCooldownMs((previos ?? []).map((p) => p.created_at as string));
  if (espera > 0) {
    return { ok: false, reason: "espera", retry_after_seconds: Math.ceil(espera / 1000) };
  }

  const ultimo = await ultimoMensajePorWhatsApp(db, contacto.id);
  if (!whatsappWindowOpen(ultimo)) return { ok: false, reason: "fuera_de_ventana" };

  const codigo = newAccessCode();
  const { data: fila, error: errFila } = await db
    .from("client_access_codes")
    .insert({
      account_id: cuenta.id,
      contact_id: contacto.id,
      phone_digits: key,
      code_hash: hashAccessCode(codigo, contacto.id),
      ip: input.ip,
      expires_at: new Date(Date.now() + ACCESS_CODE_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (errFila || !fila) {
    console.error("[client-portal] code insert failed:", errFila);
    return { ok: false, reason: "server_error" };
  }

  // El código no se guarda en la conversación: ni el asesor ni la IA
  // tienen por qué verlo, y en la app aparecería después en su chat.
  const minutos = Math.round(ACCESS_CODE_TTL_MS / 60_000);
  const texto =
    `Tu código para entrar a Golden App es ${codigo}. ` +
    `Vence en ${minutos} minutos. Si no lo pediste, ignora este mensaje.`;
  try {
    await mandarPorWhatsApp(db, cuenta.id, contacto.phone as string, texto);
  } catch (err) {
    console.error("[client-portal] code send failed:", err instanceof Error ? err.message : err);
    await db.from("client_access_codes").delete().eq("id", fila.id);
    return { ok: false, reason: "server_error" };
  }

  return {
    ok: true,
    phone_hint: maskPhone(contacto.phone as string),
    expires_in_seconds: Math.round(ACCESS_CODE_TTL_MS / 1000),
  };
}

export type EntrarConCodigoResult =
  | SignInResult
  | {
      ok: false;
      reason: "sin_cuenta" | "codigo_vencido" | "codigo_incorrecto" | "dni_en_uso" | "ya_existe";
    };

/**
 * Comprueba el código y, si es el bueno, guarda el DNI en la ficha que
 * ya existía y abre la sesión sobre ella. La conversación no se toca: es
 * la misma que tenía por WhatsApp.
 */
export async function entrarConCodigo(
  db: SupabaseClient,
  input: { phone: string; code: string; dni: string; name?: string; ip: string; userAgent: string | null },
): Promise<EntrarConCodigoResult> {
  const candidates = phoneCandidates(input.phone);
  const codigo = normalizeAccessCode(input.code);
  const dni = normalizeDni(input.dni);
  if (!candidates.length || !codigo || !dni) return { ok: false, reason: "invalid_input" };
  const key = phoneKey(input.phone);

  const cuenta = await cuentaDeRegistro(db);
  if (!cuenta) return { ok: false, reason: "sin_cuenta" };

  // Los mismos candados que el ingreso con DNI, contados en la misma tabla.
  const [{ data: porCel }, bloqueoIp] = await Promise.all([
    db
      .from("client_login_attempts")
      .select("succeeded, created_at")
      .eq("phone_digits", key)
      .gte("created_at", since(PHONE_WINDOW_MS))
      .order("created_at", { ascending: false })
      .limit(50),
    bloqueoPorIp(db, input.ip),
  ]);
  const hastaCel = phoneLockedUntil(porCel ?? []) ?? 0;
  const bloqueo = Math.max(bloqueoIp, hastaCel > Date.now() ? Math.ceil((hastaCel - Date.now()) / 1000) : 0);
  if (bloqueo) return { ok: false, reason: "locked", retry_after_seconds: bloqueo };

  // Sólo vale el último código pedido: pedir otro anula el anterior.
  const { data: filas, error } = await db
    .from("client_access_codes")
    .select("id, contact_id, code_hash, attempts, expires_at, used_at")
    .eq("account_id", cuenta.id)
    .eq("phone_digits", key)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[client-portal] code lookup failed:", error);
    return { ok: false, reason: "server_error" };
  }
  const fila = filas?.[0];
  if (
    !fila ||
    fila.used_at ||
    Date.parse(fila.expires_at as string) <= Date.now() ||
    (fila.attempts as number) >= MAX_CODE_TRIES
  ) {
    return { ok: false, reason: "codigo_vencido" };
  }

  const anotar = (ok: boolean) =>
    db.from("client_login_attempts").insert({
      phone_digits: key,
      ip: input.ip,
      succeeded: ok,
      contact_id: fila.contact_id,
    });

  if (!sameSecret(fila.code_hash as string, hashAccessCode(codigo, fila.contact_id as string))) {
    await Promise.all([
      db.from("client_access_codes").update({ attempts: (fila.attempts as number) + 1 }).eq("id", fila.id),
      anotar(false),
    ]);
    return { ok: false, reason: "codigo_incorrecto" };
  }

  // Antes de gastar el código: si el DNI es de otra ficha, que lo corrija
  // y vuelva a intentarlo con el mismo código.
  const { data: otro } = await db
    .from("contacts")
    .select("id")
    .eq("account_id", cuenta.id)
    .eq("dni", dni)
    .neq("id", fila.contact_id)
    .limit(1);
  if (otro?.length) return { ok: false, reason: "dni_en_uso" };

  // Se gasta una sola vez, aunque lleguen dos envíos a la vez.
  const { data: gastado } = await db
    .from("client_access_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", fila.id)
    .is("used_at", null)
    .select("id");
  if (!gastado?.length) return { ok: false, reason: "codigo_vencido" };

  const { data: actual } = await db
    .from("contacts")
    .select("id, account_id, name, phone, dni")
    .eq("id", fila.contact_id)
    .maybeSingle();
  if (!actual) return { ok: false, reason: "server_error" };

  if (actual.dni && actual.dni !== dni) {
    // Un asesor le puso otro DNI mientras tanto: manda la ficha.
    return { ok: false, reason: "ya_existe" };
  }
  if (!actual.dni) {
    const cambios: Record<string, string> = { dni };
    const nombre = String(input.name ?? "").trim().replace(/ +/g, " ").slice(0, 80);
    if (!String(actual.name ?? "").trim() && nombre.length >= 2) cambios.name = nombre;
    const { error: errDni } = await db
      .from("contacts")
      .update(cambios)
      .eq("id", actual.id)
      .is("dni", null);
    if (errDni) {
      if (errDni.code === "23505") return { ok: false, reason: "dni_en_uso" };
      console.error("[client-portal] saving DNI failed:", errDni);
      return { ok: false, reason: "server_error" };
    }
    actual.dni = dni;
    if (cambios.name) actual.name = cambios.name;
  }

  await anotar(true);

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const { error: errSesion } = await db.from("client_sessions").insert({
    account_id: cuenta.id,
    contact_id: actual.id,
    token_hash: hashSessionToken(token),
    user_agent: input.userAgent?.slice(0, 300) ?? null,
    expires_at: expiresAt,
  });
  if (errSesion) {
    console.error("[client-portal] session insert failed:", errSesion);
    return { ok: false, reason: "server_error" };
  }

  const contacto = {
    ...actual,
    accounts: { name: cuenta.name as string, client_portal_enabled: true },
  } as unknown as ContactRow;
  return { ok: true, token, expires_at: expiresAt, client: await resumenConTipo(db, contacto) };
}

/** Segundos que le quedan de bloqueo a esa IP, 0 si ninguno. */
async function bloqueoPorIp(db: SupabaseClient, ip: string): Promise<number> {
  const { data } = await db
    .from("client_login_attempts")
    .select("succeeded, created_at")
    .eq("ip", ip)
    .gte("created_at", since(IP_WINDOW_MS))
    .order("created_at", { ascending: false })
    .limit(100);
  const hasta = ipLockedUntil(data ?? []) ?? 0;
  return hasta > Date.now() ? Math.ceil((hasta - Date.now()) / 1000) : 0;
}

/**
 * Cuándo escribió el cliente por WhatsApp por última vez. Lo que escribió
 * en la app no cuenta: no abre la ventana de WhatsApp.
 */
async function ultimoMensajePorWhatsApp(db: SupabaseClient, contactId: string): Promise<string | null> {
  const { data: convs } = await db
    .from("conversations")
    .select("id")
    .eq("contact_id", contactId)
    .limit(20);
  const ids = (convs ?? []).map((c) => c.id as string);
  if (!ids.length) return null;

  const consulta = (conCanal: boolean) => {
    let q = db
      .from("messages")
      .select("created_at")
      .in("conversation_id", ids)
      .eq("sender_type", "customer");
    if (conCanal) q = q.or("channel.is.null,channel.eq.whatsapp");
    return q.order("created_at", { ascending: false }).limit(1);
  };
  let { data, error } = await consulta(true);
  // Sin la migración 050 no hay columna de canal: todo lo que hay es WhatsApp.
  if (error && faltaColumnaCanal(error)) ({ data, error } = await consulta(false));
  if (error) {
    console.error("[client-portal] last inbound lookup failed:", error);
    return null;
  }
  return (data?.[0]?.created_at as string | undefined) ?? null;
}

/** Texto libre por el número de WhatsApp de la cuenta, probando las variantes del celular. */
export async function mandarPorWhatsApp(db: SupabaseClient, accountId: string, phone: string, text: string) {
  // Sin conversación de por medio: sale por la línea principal.
  const config = await getPrimaryLine(db, accountId);
  if (!config) throw new Error("WhatsApp no está configurado");

  const accessToken = decrypt(config.access_token as string);
  let ultimoError: unknown = null;
  for (const variante of phoneVariants(sanitizePhoneForMeta(phone))) {
    try {
      await sendTextMessage({ phoneNumberId: config.phone_number_id as string, accessToken, to: variante, text });
      return;
    } catch (err) {
      if (!isRecipientNotAllowedError(err instanceof Error ? err.message : String(err))) throw err;
      ultimoError = err;
    }
  }
  throw ultimoError ?? new Error("sin variantes de número");
}
