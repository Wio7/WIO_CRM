// ============================================================
// El equipo de Golden Habitat escribe al mismo número de WhatsApp que los
// clientes. Antes de tratar un mensaje como de cliente, el webhook pregunta
// aquí si quien escribe es del equipo y tiene algún modo (hoy: Golden Caja).
//
//   - Si lo es, el mensaje se queda aquí: no se crea contacto ni
//     conversación, no corre la IA de clientes ni las automatizaciones y no
//     se avisa a los asesores.
//   - Si no lo es (o escribió /cliente para probar como cliente), devuelve
//     false y el webhook sigue igual que siempre.
//
// La función se enciende por organización (whatsapp_team_accounts, 075).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { conversar, ErrorAsistente } from "@/lib/assistant/run";
import { transcribirAudioDeWhatsApp } from "@/lib/ai/transcribir";
import { checkRateLimit } from "@/lib/rate-limit";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { sendInteractiveButtons, sendTextMessage } from "@/lib/whatsapp/meta-api";

import { comoLaPersona, ejecutorCaja, herramientasCaja, instruccionesCaja, type ContextoCaja } from "./caja";
import {
  MARCA_CAJA,
  esSoloSaludo,
  hoyEnLima,
  leerComando,
  lineaDeMovimiento,
  recortar,
  resumenDelDia,
  textoDelBorrador,
  type Borrador,
  type VistaDelDia,
} from "./texto";

const MENSAJES_DE_MEMORIA = 16;
const LIMITE = { limit: 20, windowMs: 60_000 };

/** Lo mínimo del mensaje de Meta que hace falta aquí. */
export interface MensajeEntrante {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  audio?: { id: string };
  interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  /** El botón de una plantilla (el "Ver detalle" del resumen nocturno). */
  button?: { text: string; payload?: string };
}

interface Sesion {
  mode: string | null;
  greeted_on: string | null;
}

/**
 * Atiende el mensaje si viene de alguien del equipo con un modo.
 * @returns true si lo atendió (el webhook no debe tratarlo como cliente)
 */
export async function atenderEquipo(e: {
  mensaje: MensajeEntrante;
  accountId: string;
  phoneNumberId: string;
  accessToken: string;
}): Promise<boolean> {
  const db = supabaseAdmin();
  const { data: miembros, error } = await db.rpc("whatsapp_team_member", {
    p_account: e.accountId,
    p_phone: normalizePhone(e.mensaje.from),
  });
  // Sin la migración 075, o si falla la consulta, todo sigue como siempre.
  if (error || !miembros?.length) return false;
  const miembro = miembros[0] as { user_id: string; name: string };

  let vista: VistaDelDia;
  try {
    vista = await comoLaPersona<VistaDelDia>({ db, userId: miembro.user_id }, "overview");
  } catch {
    return false;
  }
  // Sin cajas a la vista no tiene ningún modo: se le atiende como hoy.
  if (!vista.boxes.length) return false;

  const { data: fila } = await db
    .from("whatsapp_team_sessions")
    .select("mode, greeted_on")
    .eq("account_id", e.accountId)
    .eq("user_id", miembro.user_id)
    .maybeSingle();
  const sesion: Sesion = fila ?? { mode: null, greeted_on: null };
  const textoPlano = e.mensaje.text?.body ?? "";

  // Probando como cliente: sólo /salir lo trae de vuelta.
  if (sesion.mode === "cliente" && leerComando(textoPlano) !== "salir") return false;

  const ctx: ContextoCaja = {
    db,
    userId: miembro.user_id,
    accountId: e.accountId,
    nombre: miembro.name,
    esDueno: vista.isOwner,
  };
  const turno = new Turno(e, ctx, vista, sesion);
  try {
    await turno.atender();
  } catch (err) {
    console.error("[equipo] no se pudo atender:", err);
    await turno.enviar("Se me cruzó algo y no pude responder. Intenta de nuevo en un momento.");
  }
  return true;
}

class Turno {
  private readonly db: SupabaseClient;
  constructor(
    private readonly e: Parameters<typeof atenderEquipo>[0],
    private readonly ctx: ContextoCaja,
    private readonly vista: VistaDelDia,
    private readonly sesion: Sesion,
  ) {
    this.db = ctx.db;
  }

  async atender() {
    await this.guardarSesion({ last_inbound_at: new Date().toISOString() });

    if (!checkRateLimit(`wa-equipo:${this.ctx.userId}`, LIMITE).success) {
      await this.enviar("Vas muy rápido. Espera un minuto y me escribes de nuevo.");
      return;
    }

    // Tocó "Ver detalle" en la plantilla del resumen: va el detalle del día.
    if (this.e.mensaje.type === "button") return this.ejecutarComando("resumen");

    const boton = this.e.mensaje.interactive?.button_reply?.id ?? this.e.mensaje.interactive?.list_reply?.id;
    if (boton) return this.tocoBoton(boton);

    let texto = this.e.mensaje.text?.body?.trim() ?? "";
    if (this.e.mensaje.type === "audio" && this.e.mensaje.audio?.id) {
      texto = (await transcribirAudioDeWhatsApp(this.e.mensaje.audio.id, this.e.accessToken)).trim();
      if (!texto) {
        await this.enviar("No te entendí el audio. ¿Me lo repites o me lo escribes?");
        return;
      }
    }
    if (!texto) {
      await this.enviar(`${MARCA_CAJA}\nPor ahora entiendo texto y notas de voz.`);
      return;
    }

    const comando = leerComando(texto);
    if (comando) return this.ejecutarComando(comando);

    // El primer mensaje del día abre con el resumen de las cajas.
    if (this.sesion.greeted_on !== hoyEnLima() || this.sesion.mode !== "caja") {
      await this.saludar();
      if (esSoloSaludo(texto)) return;
    } else if (esSoloSaludo(texto)) {
      await this.enviar(`${MARCA_CAJA}\nHola, ${this.ctx.nombre}. ¿Qué necesitas de las cajas? (escribe /resumen para ver el día)`);
      return;
    }
    await this.preguntar(texto);
  }

  private async ejecutarComando(comando: NonNullable<ReturnType<typeof leerComando>>) {
    switch (comando) {
      case "caja":
      case "menu":
      case "salir":
        // Hoy Caja es el único modo: con un solo modo no hay botones, se entra directo.
        await this.saludar();
        return;
      case "resumen":
        await this.enviar(`${MARCA_CAJA}\n${resumenDelDia(this.vista)}`);
        return;
      case "app":
      case "legal":
        await this.enviar("Ese asistente todavía no está por WhatsApp. Sigue en su app. Aquí tienes Golden Caja.");
        return;
      case "cliente":
        await this.guardarSesion({ mode: "cliente" });
        await this.enviar("Listo: desde ahora este número te atiende como a un cliente. Escribe /salir para volver a Golden Caja.");
        return;
      case "olvidar":
        await this.db
          .from("whatsapp_team_messages")
          .delete()
          .eq("user_id", this.ctx.userId)
          .eq("account_id", this.ctx.accountId)
          .eq("mode", "caja");
        await this.enviar(`${MARCA_CAJA}\nEmpezamos de cero: olvidé nuestra conversación de caja.`);
        return;
    }
  }

  private async saludar() {
    const nombres = this.vista.boxes.map((c) => c.name);
    const lista = nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} y ${nombres.at(-1)}` : nombres[0];
    const saludo = `Hola, ${this.ctx.nombre}. Esto es lo que pasó hoy en ${lista}:`;
    const cierre = this.ctx.esDueno
      ? "Pregúntame lo que quieras o dicta un gasto (también por nota de voz)."
      : "Pregúntame lo que quieras de tu caja.";
    await this.enviar(`${MARCA_CAJA}\n${resumenDelDia(this.vista, saludo)}\n\n${cierre}`);
    await this.guardarSesion({ mode: "caja", greeted_on: hoyEnLima() });
  }

  private async preguntar(pregunta: string) {
    const { data: hilo } = await this.db
      .from("whatsapp_team_messages")
      .select("role, content")
      .eq("user_id", this.ctx.userId)
      .eq("account_id", this.ctx.accountId)
      .eq("mode", "caja")
      .order("created_at", { ascending: false })
      .limit(MENSAJES_DE_MEMORIA);
    const historial = ((hilo ?? []) as { role: "user" | "assistant"; content: string }[]).reverse();

    const caja = ejecutorCaja(this.ctx);
    let respuesta: string;
    try {
      respuesta = await conversar({
        db: this.db,
        accountId: this.ctx.accountId,
        sistema: instruccionesCaja(this.ctx),
        herramientas: herramientasCaja(this.ctx),
        ejecutar: caja.ejecutar,
        historial,
        pregunta,
      });
    } catch (err) {
      const motivo = err instanceof ErrorAsistente ? err.message : "Algo falló.";
      await this.enviar(`${MARCA_CAJA}\nNo pude pensar la respuesta ahora. ${motivo}`);
      return;
    }

    await this.recordar("user", pregunta);
    await this.recordar("assistant", respuesta);
    await this.enviar(`${MARCA_CAJA}\n${respuesta}`);

    const propuesta = caja.propuesta();
    if (propuesta) {
      await sendInteractiveButtons({
        phoneNumberId: this.e.phoneNumberId,
        accessToken: this.e.accessToken,
        to: this.e.mensaje.from,
        bodyText: recortar(textoDelBorrador(propuesta.borrador), 1024),
        footerText: "El borrador vence en 10 minutos",
        buttons: [
          { id: `caja:si:${propuesta.id}`, title: "✅ Sí, guardar" },
          { id: `caja:corregir:${propuesta.id}`, title: "✏️ Corregir" },
          { id: `caja:cancelar:${propuesta.id}`, title: "❌ Cancelar" },
        ],
      });
    }
  }

  /** Sólo un toque en "Sí, guardar" guarda plata; un "sí" escrito no cuenta. */
  private async tocoBoton(id: string) {
    const m = id.match(/^caja:(si|corregir|cancelar):([0-9a-f-]{36})$/);
    if (!m) {
      await this.saludar();
      return;
    }
    const [, accion, borradorId] = m;
    const { data: d } = await this.db
      .from("whatsapp_team_drafts")
      .select("id, command, summary, status, expires_at")
      .eq("id", borradorId)
      .eq("user_id", this.ctx.userId)
      .eq("account_id", this.ctx.accountId)
      .maybeSingle();
    if (!d) {
      await this.enviar(`${MARCA_CAJA}\nNo encontré ese borrador.`);
      return;
    }
    const borrador = JSON.parse(d.summary as string) as Borrador;
    const linea = lineaDeMovimiento(borrador);
    if (d.status === "saved") {
      await this.enviar(`${MARCA_CAJA}\nEse ya quedó guardado: ${linea}`);
      return;
    }
    if (d.status !== "pending") {
      await this.enviar(`${MARCA_CAJA}\nEse borrador ya no está activo. Si quieres registrarlo, dímelo de nuevo.`);
      return;
    }

    const cerrar = (status: "saved" | "cancelled" | "failed", resultId?: string) =>
      this.db
        .from("whatsapp_team_drafts")
        .update({ status, result_id: resultId ?? null, decided_at: new Date().toISOString() })
        .eq("id", d.id)
        .eq("status", "pending");

    if (accion === "cancelar") {
      await cerrar("cancelled");
      await this.recordar("assistant", `(Canceló el borrador: ${linea}. No se guardó.)`);
      await this.enviar(`${MARCA_CAJA}\nCancelado. No guardé nada.`);
      return;
    }
    if (accion === "corregir") {
      await cerrar("cancelled");
      await this.recordar("assistant", `(Quiere corregir el borrador: ${linea}. Pregúntale qué cambia y vuelve a proponerlo.)`);
      await this.enviar(`${MARCA_CAJA}\n¿Qué cambio? Dímelo y lo armo de nuevo.`);
      return;
    }
    if (new Date(d.expires_at as string).getTime() < Date.now()) {
      await cerrar("cancelled");
      await this.enviar(`${MARCA_CAJA}\nEse borrador venció (duran 10 minutos). Dímelo de nuevo y lo vuelvo a armar.`);
      return;
    }

    try {
      const entrada = await comoLaPersona<string>(this.ctx, "entry", d.command as Record<string, unknown>);
      await cerrar("saved", entrada);
      await this.recordar("assistant", `(Guardado: ${linea})`);
      await this.enviar(`${MARCA_CAJA}\nListo: ${linea}`);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : "Error desconocido";
      await cerrar("failed");
      await this.recordar("assistant", `(No se guardó ${linea}: ${motivo})`);
      await this.enviar(`${MARCA_CAJA}\nNo se guardó: ${motivo}`);
    }
  }

  private async recordar(role: "user" | "assistant", content: string) {
    const { error } = await this.db.from("whatsapp_team_messages").insert({
      account_id: this.ctx.accountId,
      user_id: this.ctx.userId,
      mode: "caja",
      role,
      content: content.slice(0, 4000),
    });
    if (error) console.error("[equipo] no se guardó el hilo:", error.message);
  }

  private async guardarSesion(cambios: Partial<{ mode: string | null; greeted_on: string; last_inbound_at: string }>) {
    Object.assign(this.sesion, cambios);
    const { error } = await this.db.from("whatsapp_team_sessions").upsert(
      {
        account_id: this.ctx.accountId,
        user_id: this.ctx.userId,
        ...cambios,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "account_id,user_id" },
    );
    if (error) console.error("[equipo] no se guardó la sesión:", error.message);
  }

  async enviar(texto: string) {
    try {
      await sendTextMessage({
        phoneNumberId: this.e.phoneNumberId,
        accessToken: this.e.accessToken,
        to: this.e.mensaje.from,
        text: recortar(texto, 4096),
      });
    } catch (err) {
      console.error("[equipo] no se pudo enviar:", err);
    }
  }
}
