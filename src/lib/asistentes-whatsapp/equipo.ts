// ============================================================
// El equipo de Golden Habitat escribe al mismo número de WhatsApp que los
// clientes. Antes de tratar un mensaje como de cliente, el webhook pregunta
// aquí si quien escribe es del equipo y tiene algún asistente:
//
//   - 💼 Golden Caja: quien ve alguna caja (los encargados, sólo la suya).
//   - 🏠 Golden App: los dueños de caja (Bryce y Eric), el Asistente Golden.
//   - ⚖️ Golden Legal: los dueños de caja y el equipo legal, sólo consulta.
//
// Si lo es, el mensaje se queda aquí: no se crea contacto ni conversación,
// no corre la IA de clientes ni las automatizaciones y no se avisa a los
// asesores. Si no lo es (o eligió escribir como cliente: el botón tras tocar
// Golden App, o /cliente), devuelve false y el webhook sigue igual que siempre.
//
// La conversación vuelve a empezar tras una hora sin escribir, o con un
// "hola": sale el menú con los asistentes y cada uno sólo recuerda lo dicho
// desde ese nuevo comienzo. Lo que escribió antes de elegir lo contesta el
// asistente que elija.
//
// La función se enciende por organización (whatsapp_team_accounts, 075).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { conversar, responder, ErrorAsistente } from "@/lib/assistant/run";
import { transcribirAudioDeWhatsApp } from "@/lib/ai/transcribir";
import { checkRateLimit } from "@/lib/rate-limit";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { sendInteractiveButtons, sendTextMessage } from "@/lib/whatsapp/meta-api";

import { comoLaPersona, ejecutorCaja, herramientasCaja, instruccionesCaja, type ContextoCaja } from "./caja";
import { HERRAMIENTAS_LEGAL, ejecutorLegal, fotoLegal, instruccionesLegal, saludoLegal } from "./legal";
import { clienteDeLaPersona } from "./sesion";
import {
  MODOS,
  aWhatsApp,
  esSoloSaludo,
  leerComando,
  lineaDeMovimiento,
  recortar,
  resumenDelDia,
  textoDelBorrador,
  type Borrador,
  type Modo,
  type VistaDelDia,
} from "./texto";

const MENSAJES_DE_MEMORIA = 16;
const LIMITE = { limit: 20, windowMs: 60_000 };
/** Sin escribir por más de esto, la conversación vuelve a empezar con el menú. */
export const PAUSA_PARA_REINICIAR_MS = 60 * 60 * 1000;

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
  last_inbound_at: string | null;
  session_started_at: string | null;
  pending_question: string | null;
}

interface Persona {
  userId: string;
  nombre: string;
  accountId: string;
  modos: Modo[];
  esDueno: boolean;
  vista: VistaDelDia | null;
}

/** Qué asistentes tiene la persona, en el orden de los botones. */
async function quienEs(db: SupabaseClient, accountId: string, miembro: { user_id: string; name: string }): Promise<Persona> {
  let vista: VistaDelDia | null = null;
  try {
    vista = await comoLaPersona<VistaDelDia>({ db, userId: miembro.user_id }, "overview");
  } catch {
    // Sin acceso a cajas: puede tener otro asistente.
  }
  const esDueno = !!vista?.isOwner;
  const [{ data: legalEncendido }, { data: equipoLegal }] = await Promise.all([
    db.from("legal_enabled_accounts").select("account_id").eq("account_id", accountId).maybeSingle(),
    db.from("legal_members").select("user_id").eq("account_id", accountId).eq("user_id", miembro.user_id).maybeSingle(),
  ]);
  const modos: Modo[] = [];
  if (vista?.boxes.length) modos.push("caja");
  if (esDueno) modos.push("app");
  if (legalEncendido && (esDueno || equipoLegal)) modos.push("legal");
  return { userId: miembro.user_id, nombre: miembro.name, accountId, modos, esDueno, vista };
}

/**
 * Atiende el mensaje si viene de alguien del equipo con algún asistente.
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

  const persona = await quienEs(db, e.accountId, miembros[0] as { user_id: string; name: string });
  // Sin ningún asistente: se le atiende como hoy.
  if (!persona.modos.length) return false;

  const { data: fila } = await db
    .from("whatsapp_team_sessions")
    .select("mode, last_inbound_at, session_started_at, pending_question")
    .eq("account_id", e.accountId)
    .eq("user_id", persona.userId)
    .maybeSingle();
  const sesion: Sesion = fila ?? { mode: null, last_inbound_at: null, session_started_at: null, pending_question: null };

  // Probando como cliente: sólo /salir lo trae de vuelta.
  if (sesion.mode === "cliente" && leerComando(e.mensaje.text?.body ?? "") !== "salir") return false;

  const turno = new Turno(e, db, persona, sesion);
  try {
    await turno.atender();
  } catch (err) {
    console.error("[equipo] no se pudo atender:", err);
    await turno.enviar("Se me cruzó algo y no pude responder. Intenta de nuevo en un momento.");
  }
  return true;
}

class Turno {
  constructor(
    private readonly e: Parameters<typeof atenderEquipo>[0],
    private readonly db: SupabaseClient,
    private readonly persona: Persona,
    private readonly sesion: Sesion,
  ) {}

  private get ctxCaja(): ContextoCaja {
    return {
      db: this.db,
      userId: this.persona.userId,
      accountId: this.persona.accountId,
      nombre: this.persona.nombre,
      esDueno: this.persona.esDueno,
    };
  }

  private modoActual(): Modo | null {
    const m = this.sesion.mode as Modo | null;
    return m && this.persona.modos.includes(m) ? m : null;
  }

  async atender() {
    const antes = this.sesion.last_inbound_at;
    const enPausa = !antes || Date.now() - new Date(antes).getTime() > PAUSA_PARA_REINICIAR_MS;
    await this.guardarSesion({ last_inbound_at: new Date().toISOString() });

    if (!checkRateLimit(`wa-equipo:${this.persona.userId}`, LIMITE).success) {
      await this.enviar("Vas muy rápido. Espera un minuto y me escribes de nuevo.");
      return;
    }

    // Tocó "Ver detalle" en la plantilla del resumen: va el detalle del día.
    if (this.e.mensaje.type === "button" && this.persona.modos.includes("caja")) return this.elegir("caja");

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
      await this.enviar("Por ahora entiendo texto y notas de voz.");
      return;
    }

    const comando = leerComando(texto);
    if (comando) return this.ejecutarComando(comando);

    const modo = this.modoActual();
    if (enPausa || !modo || !this.sesion.session_started_at || esSoloSaludo(texto)) {
      await this.empezarDeNuevo(esSoloSaludo(texto) ? null : texto);
      return this.abrir();
    }
    await this.preguntar(modo, texto);
  }

  private async ejecutarComando(comando: NonNullable<ReturnType<typeof leerComando>>) {
    switch (comando) {
      case "menu":
      case "salir":
        await this.empezarDeNuevo(null);
        return this.abrir();
      case "caja":
      case "app":
      case "legal":
        if (!this.persona.modos.includes(comando)) {
          await this.enviar(`No tienes acceso a ${MODOS[comando].nombre} por WhatsApp.`);
          return;
        }
        await this.empezarDeNuevo(null);
        return this.elegir(comando);
      case "resumen":
        if (!this.persona.vista?.boxes.length) {
          await this.enviar("No tienes ninguna caja a la vista.");
          return;
        }
        await this.enviar(`${MODOS.caja.marca}\n${resumenDelDia(this.persona.vista)}`);
        return;
      case "cliente":
        return this.pasarACliente();
      case "olvidar": {
        const modo = this.modoActual();
        if (!modo) {
          await this.enviar("Primero elige un asistente: escribe /menu.");
          return;
        }
        if (modo === "app") {
          const db = await clienteDeLaPersona(this.persona.userId);
          await db.from("assistant_messages").delete().eq("user_id", this.persona.userId);
        } else {
          await this.db
            .from("whatsapp_team_messages")
            .delete()
            .eq("user_id", this.persona.userId)
            .eq("account_id", this.persona.accountId)
            .eq("mode", modo);
        }
        await this.enviar(`${MODOS[modo].marca}\nEmpezamos de cero: olvidé nuestra conversación.`);
        return;
      }
    }
  }

  /** Nueva conversación: sin asistente elegido y con la memoria desde ahora. */
  private async empezarDeNuevo(pendiente: string | null) {
    await this.guardarSesion({
      mode: null,
      session_started_at: new Date().toISOString(),
      pending_question: pendiente ? pendiente.slice(0, 2000) : null,
    });
  }

  /** Con un solo asistente se entra directo; con varios, el menú. */
  private async abrir() {
    if (this.persona.modos.length === 1) return this.elegir(this.persona.modos[0]);
    const espera = this.sesion.pending_question ? "\n\nTe contesta el que elijas." : "";
    await sendInteractiveButtons({
      phoneNumberId: this.e.phoneNumberId,
      accessToken: this.e.accessToken,
      to: this.e.mensaje.from,
      bodyText: `Hola, ${this.persona.nombre}. ¿Con qué asistente quieres hablar?${espera}`,
      footerText: "Cambia cuando quieras con /menu",
      buttons: this.persona.modos.map((m) => ({ id: `modo:${m}`, title: MODOS[m].boton })),
    });
  }

  /** Al tocar Golden App: entrar al asistente o probar el número como cliente. */
  private async preguntarComoEscribe() {
    await sendInteractiveButtons({
      phoneNumberId: this.e.phoneNumberId,
      accessToken: this.e.accessToken,
      to: this.e.mensaje.from,
      bodyText: `${MODOS.app.marca}
¿Cómo quieres escribir, ${this.persona.nombre}?`,
      footerText: "Como cliente, tus mensajes entran a la bandeja",
      buttons: [
        { id: "app:cliente", title: "Como cliente" },
        { id: "app:asistente", title: "Como asistente" },
      ],
    });
  }

  /** Desde aquí lo atiende el flujo de clientes, hasta que escriba /salir. */
  private async pasarACliente() {
    await this.guardarSesion({ mode: "cliente", pending_question: null });
    await this.enviar(
      "Listo: desde ahora este número te atiende como a un cliente y lo que escribas entra a la bandeja del CRM. Escribe /salir para volver a tus asistentes.",
    );
  }

  private async elegir(modo: Modo) {
    const pendiente = this.sesion.pending_question;
    await this.guardarSesion({
      mode: modo,
      pending_question: null,
      ...(this.sesion.session_started_at ? {} : { session_started_at: new Date().toISOString() }),
    });
    await this.saludar(modo);
    if (pendiente) await this.preguntar(modo, pendiente);
  }

  private async saludar(modo: Modo) {
    const { nombre } = this.persona;
    if (modo === "caja") {
      const vista = this.persona.vista!;
      const nombres = vista.boxes.map((c) => c.name);
      const lista = nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} y ${nombres.at(-1)}` : nombres[0];
      const cierre = this.persona.esDueno
        ? "Pregúntame lo que quieras o dicta un gasto (también por nota de voz)."
        : "Pregúntame lo que quieras de tu caja.";
      await this.enviar(
        `${MODOS.caja.marca}\n${resumenDelDia(vista, `Hola, ${nombre}. Esto es lo que pasó hoy en ${lista}:`)}\n\n${cierre}`,
      );
      return;
    }
    if (modo === "app") {
      await this.enviar(
        `${MODOS.app.marca}\nHola, ${nombre}. Soy el Asistente Golden: tus clientes, la agenda, el catálogo y el equipo. ¿Qué necesitas?`,
      );
      return;
    }
    try {
      const foto = await fotoLegal(await clienteDeLaPersona(this.persona.userId));
      await this.enviar(`${MODOS.legal.marca}\n${saludoLegal(nombre, foto)}`);
    } catch (err) {
      console.error("[equipo] Golden Legal:", err);
      await this.enviar(`${MODOS.legal.marca}\nNo pude entrar a Golden Legal ahora. ${err instanceof Error ? err.message : ""}`);
    }
  }

  private async preguntar(modo: Modo, pregunta: string) {
    let respuesta: string;
    let propuesta: ReturnType<ReturnType<typeof ejecutorCaja>["propuesta"]> = null;
    try {
      if (modo === "app") {
        respuesta = await this.preguntarApp(pregunta);
      } else {
        const historial = await this.hilo(modo);
        if (modo === "caja") {
          const caja = ejecutorCaja(this.ctxCaja);
          respuesta = await conversar({
            db: this.db,
            accountId: this.persona.accountId,
            sistema: instruccionesCaja(this.ctxCaja),
            herramientas: herramientasCaja(this.ctxCaja),
            ejecutar: caja.ejecutar,
            historial,
            pregunta,
          });
          propuesta = caja.propuesta();
        } else {
          const db = await clienteDeLaPersona(this.persona.userId);
          const ctx = { db, nombre: this.persona.nombre };
          respuesta = await conversar({
            db,
            accountId: this.persona.accountId,
            sistema: instruccionesLegal(ctx),
            herramientas: HERRAMIENTAS_LEGAL,
            ejecutar: ejecutorLegal(ctx),
            historial,
            pregunta,
          });
        }
        await this.recordar(modo, "user", pregunta);
        await this.recordar(modo, "assistant", respuesta);
      }
    } catch (err) {
      const motivo = err instanceof ErrorAsistente || err instanceof Error ? err.message : "Algo falló.";
      console.error(`[equipo] ${modo}:`, err);
      await this.enviar(`${MODOS[modo].marca}\nNo pude pensar la respuesta ahora. ${motivo}`);
      return;
    }

    await this.enviar(`${MODOS[modo].marca}\n${aWhatsApp(respuesta)}`);

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

  /**
   * El Asistente Golden de siempre, con la sesión de la persona. Su hilo es
   * el mismo de la app (assistant_messages): lo que hable aquí lo ve allá.
   */
  private async preguntarApp(pregunta: string): Promise<string> {
    const db = await clienteDeLaPersona(this.persona.userId);
    const { data: perfil } = await db
      .from("profiles")
      .select("account_id, account_role, full_name, email, area")
      .eq("user_id", this.persona.userId)
      .maybeSingle();
    if (!perfil?.account_id) throw new Error("Tu perfil no tiene organización.");
    const ctx = {
      db,
      userId: this.persona.userId,
      accountId: perfil.account_id as string,
      rol: perfil.account_role as string,
      area: (perfil.area as string | null) ?? null,
      nombre: this.persona.nombre,
    };

    let consulta = db
      .from("assistant_messages")
      .select("role, content")
      .eq("user_id", ctx.userId)
      .order("created_at", { ascending: false })
      .limit(MENSAJES_DE_MEMORIA);
    if (this.sesion.session_started_at) consulta = consulta.gte("created_at", this.sesion.session_started_at);
    const { data: previos } = await consulta;

    const { texto, acciones } = await responder(
      ctx,
      ((previos ?? []) as { role: "user" | "assistant"; content: string }[]).reverse(),
      pregunta,
    );
    await db.from("assistant_messages").insert([
      { account_id: ctx.accountId, user_id: ctx.userId, role: "user", content: pregunta },
      { account_id: ctx.accountId, user_id: ctx.userId, role: "assistant", content: texto, actions: acciones.length ? acciones : null },
    ]);
    return texto;
  }

  /** El hilo del modo desde que empezó esta conversación. */
  private async hilo(modo: "caja" | "legal") {
    let consulta = this.db
      .from("whatsapp_team_messages")
      .select("role, content")
      .eq("user_id", this.persona.userId)
      .eq("account_id", this.persona.accountId)
      .eq("mode", modo)
      .order("created_at", { ascending: false })
      .limit(MENSAJES_DE_MEMORIA);
    if (this.sesion.session_started_at) consulta = consulta.gte("created_at", this.sesion.session_started_at);
    const { data } = await consulta;
    return ((data ?? []) as { role: "user" | "assistant"; content: string }[]).reverse();
  }

  private async tocoBoton(id: string) {
    const modo = id.match(/^modo:(caja|app|legal)$/)?.[1] as Modo | undefined;
    if (modo) {
      if (!this.persona.modos.includes(modo)) return this.abrir();
      if (modo === "app") return this.preguntarComoEscribe();
      return this.elegir(modo);
    }
    if (this.persona.modos.includes("app")) {
      if (id === "app:asistente") return this.elegir("app");
      if (id === "app:cliente") return this.pasarACliente();
    }
    const m = id.match(/^caja:(si|corregir|cancelar):([0-9a-f-]{36})$/);
    if (m) return this.decidirBorrador(m[1] as "si" | "corregir" | "cancelar", m[2]);
    return this.abrir();
  }

  /** Sólo un toque en "Sí, guardar" guarda plata; un "sí" escrito no cuenta. */
  private async decidirBorrador(accion: "si" | "corregir" | "cancelar", borradorId: string) {
    const marca = MODOS.caja.marca;
    const { data: d } = await this.db
      .from("whatsapp_team_drafts")
      .select("id, command, summary, status, expires_at")
      .eq("id", borradorId)
      .eq("user_id", this.persona.userId)
      .eq("account_id", this.persona.accountId)
      .maybeSingle();
    if (!d) {
      await this.enviar(`${marca}\nNo encontré ese borrador.`);
      return;
    }
    // Tocar un botón del borrador vuelve a Caja, aunque estuviera en otro asistente.
    if (this.sesion.mode !== "caja") await this.guardarSesion({ mode: "caja" });
    const borrador = JSON.parse(d.summary as string) as Borrador;
    const linea = lineaDeMovimiento(borrador);
    if (d.status === "saved") {
      await this.enviar(`${marca}\nEse ya quedó guardado: ${linea}`);
      return;
    }
    if (d.status !== "pending") {
      await this.enviar(`${marca}\nEse borrador ya no está activo. Si quieres registrarlo, dímelo de nuevo.`);
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
      await this.recordar("caja", "assistant", `(Canceló el borrador: ${linea}. No se guardó.)`);
      await this.enviar(`${marca}\nCancelado. No guardé nada.`);
      return;
    }
    if (accion === "corregir") {
      await cerrar("cancelled");
      await this.recordar("caja", "assistant", `(Quiere corregir el borrador: ${linea}. Pregúntale qué cambia y vuelve a proponerlo.)`);
      await this.enviar(`${marca}\n¿Qué cambio? Dímelo y lo armo de nuevo.`);
      return;
    }
    if (new Date(d.expires_at as string).getTime() < Date.now()) {
      await cerrar("cancelled");
      await this.enviar(`${marca}\nEse borrador venció (duran 10 minutos). Dímelo de nuevo y lo vuelvo a armar.`);
      return;
    }

    try {
      const entrada = await comoLaPersona<string>(this.ctxCaja, "entry", d.command as Record<string, unknown>);
      await cerrar("saved", entrada);
      await this.recordar("caja", "assistant", `(Guardado: ${linea})`);
      await this.enviar(`${marca}\nListo: ${linea}`);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : "Error desconocido";
      await cerrar("failed");
      await this.recordar("caja", "assistant", `(No se guardó ${linea}: ${motivo})`);
      await this.enviar(`${marca}\nNo se guardó: ${motivo}`);
    }
  }

  private async recordar(modo: "caja" | "legal", role: "user" | "assistant", content: string) {
    const { error } = await this.db.from("whatsapp_team_messages").insert({
      account_id: this.persona.accountId,
      user_id: this.persona.userId,
      mode: modo,
      role,
      content: content.slice(0, 4000),
    });
    if (error) console.error("[equipo] no se guardó el hilo:", error.message);
  }

  private async guardarSesion(cambios: Partial<Sesion>) {
    Object.assign(this.sesion, cambios);
    const { error } = await this.db.from("whatsapp_team_sessions").upsert(
      {
        account_id: this.persona.accountId,
        user_id: this.persona.userId,
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
