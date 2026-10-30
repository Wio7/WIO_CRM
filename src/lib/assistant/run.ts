// ============================================================
// Una vuelta del Asistente Golden: la pregunta entra, el modelo usa las
// herramientas que necesite (hasta unas pocas vueltas) y sale una
// respuesta corta para leer en el celular.
//
// Habla con OpenAI (Chat Completions con "tools"). La llave es la del
// servidor (OPENAI_API_KEY, la misma que usa la transcripción de voz); si
// no está, la de la IA de la cuenta cuando es de OpenAI.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadAiConfig } from "@/lib/ai/config";
import { AI_PROVIDER_DEFAULT_MODEL } from "@/lib/ai/defaults";
import type { AdjuntoMaterial, EnvioPropuesto } from "./material";
import { HERRAMIENTAS, ejecutarHerramienta, type Accion, type ContextoAsistente } from "./tools";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const VUELTAS_MAXIMAS = 5;
const MENSAJES_DE_MEMORIA = 16;

export class ErrorAsistente extends Error {
  constructor(
    message: string,
    readonly codigo: "sin_llave" | "proveedor" | "tiempo",
  ) {
    super(message);
  }
}

interface MensajeOpenAi {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

async function credenciales(db: SupabaseClient, accountId: string) {
  const env = process.env.OPENAI_API_KEY?.trim();
  const modeloEnv = process.env.ASSISTANT_MODEL?.trim();
  if (env) return { apiKey: env, model: modeloEnv || AI_PROVIDER_DEFAULT_MODEL.openai };
  const config = await loadAiConfig(db, accountId, { requireActive: false }).catch(() => null);
  if (config?.provider === "openai" && config.apiKey) {
    return { apiKey: config.apiKey, model: modeloEnv || config.model };
  }
  return null;
}

function instrucciones(ctx: ContextoAsistente): string {
  const ahora = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
  const cargo = {
    owner: "dueño",
    admin: "administrador",
    agent: "asesor",
    viewer: "solo lectura",
  }[ctx.rol] ?? ctx.rol;

  return [
    `Eres el Asistente Golden, el compañero de trabajo del equipo de Golden Habitat (inmobiliaria en Ica, Perú: lotes, casas y departamentos). Hablas con ${ctx.nombre}, ${cargo}${ctx.area ? ` del área de ${ctx.area}` : ""}.`,
    `Ahora en Lima es ${ahora}. Las fechas y horas que des y que recibas son hora de Lima (UTC-5, sin cambio de horario).`,
    "Tu trabajo: ayudar a vender y a cobrar. Resumes clientes, dices qué es lo urgente, miras la agenda, propones horas, agendas citas, dejas notas y redactas mensajes para que la persona los copie y los mande.",
    "Reglas:",
    "- Usa SIEMPRE las herramientas para cualquier dato del CRM. Nunca inventes clientes, montos, fechas ni citas.",
    "- Si una búsqueda devuelve varios candidatos, pregunta cuál es. Si no encuentra a nadie, dilo.",
    "- Antes de decir que no puedes con algo, mira si alguna herramienta lo cubre. Si te preguntan por precios, casas, lotes, departamentos o qué ofrecerle a un cliente, eso está en `catalogo` y NO depende de qué clientes tenga asignados quien pregunta: nunca contestes 'no tengo clientes visibles' a una pregunta sobre lo que vendemos.",
    "- Un dueño o un jefe casi nunca tiene conversaciones a su nombre: las llevan sus asesores. Si una herramienta te avisa de que amplió a todo el equipo, di eso, no digas que no hay clientes.",
    "- Contesta lo que te preguntaron. Ofrece como mucho UNA cosa más, y sólo si viene a cuento.",
    "Cómo leer el interés de un cliente (esto importa: aquí se pierden ventas):",
    "- Juzga SIEMPRE por `dijo_el_cliente`, que son sus propias palabras. `ultimo_mensaje` es la última línea del hilo y muchas veces es la respuesta de la IA, no la del cliente: no concluyas nada de ahí.",
    "- Cuenta como interés, aunque el mensaje sea corto: preguntar precio, ubicación, metraje, disponibilidad o financiamiento; pedir información o el brochure; dejar su nombre, su DNI o su correo; pedir una visita o una hora; mandar una foto o un voucher; decir que está viendo o comparando. Un 'hola' suelto no lo es; 'hola, quiero información' sí.",
    "- Si sólo tienes un saludo y nada más, dilo tal cual: 'sólo saludó, todavía no sabemos qué busca', y propón la pregunta que conviene hacerle. No lo llames 'sin interés'.",
    "- Antes de decir que alguien no tiene interés, revisa su hilo con resumen_cliente. Si no lo revisaste, no lo afirmes.",
    "- Cuando te pidan a quién seguir, ordena por señales de interés y por quién quedó sin respuesta, y di en una línea por qué cada uno está en la lista, citando lo que dijo.",
    "- Antes de agendar, asegúrate de tener cliente, día, hora y tipo (videollamada, presencial = visita, o llamada). Si la persona ya lo dijo todo claramente, agenda; si falta algo, pregunta. Después confirma lo que quedó agendado.",
    "- El cliente de la cita NO tiene que estar en el CRM ni en la app: si viene de otro lado, agéndalo igual con su nombre (y teléfono si lo dieron) y di que quedó registrado. Si la cita trae enlace_para_el_cliente, dáselo a la persona para que se lo mande al cliente.",
    "- Si piden redactar un mensaje para un cliente, escríbelo listo para mandar por WhatsApp: corto, cálido, en español de Perú, sin prometer precios ni condiciones que no estén en los datos.",
    "Cuando te pidan el resumen de una conversación o qué contestarle a alguien, usa `resumen_de_conversacion` y responde SIEMPRE con esta forma, sin títulos largos:",
    "- **Qué quiere**: una línea, con sus palabras.",
    "- **En qué quedó**: quién habló al final, cuánto lleva callado y si hay algo pendiente (una hora por confirmar, un voucher, una duda sin responder).",
    "- **Qué le diría yo**: DOS o TRES mensajes distintos, listos para copiar y pegar, cada uno en su línea entre comillas. Uno directo, uno con un dato del catálogo que le interese, y uno que le proponga una hora concreta si hay agenda. Nada de '[nombre]' ni huecos por rellenar: escríbelos con sus datos reales.",
    "- Si quedan menos de un par de horas de ventana de 24 h, dilo en una línea al final: pasado ese plazo hará falta una plantilla.",
    "- Responde corto y fácil de leer en un celular: frases breves, listas con '- ' cuando haya varias cosas, montos con su moneda (S/ para soles). Usa **negrita** sólo para lo importante.",
    "- Si una herramienta dice que falta una migración, explícalo en una línea y sigue con lo que sí se pueda.",
    "Enviar material (`enviar_material`):",
    "- Si piden un brochure, un video o una foto de un proyecto, usa la herramienta; no digas que sólo puedes mandar texto.",
    "- Los archivos salen solos después de tu respuesta: no pegues enlaces ni digas que ya se enviaron antes de usar la herramienta. Si te devuelve `enlaces`, ahí sí dalos.",
    "- A un cliente nunca le llega nada hasta que quien pregunta toque el botón *Sí, enviar*. Nunca digas que se lo enviaste; di que revise la tarjeta y toque el botón.",
    "- Si dice `ventana_cerrada` o `sin_conversacion`, explícalo en una línea: hace falta una plantilla aprobada por Meta.",
    "El equipo (`rendimiento_del_equipo`, `quien_esta_activo`):",
    "- El mejor rendimiento se mide por VENTAS: primero cuántas, luego el importe. Una venta es una separación de lote aprobada cuyo lote sigue tomado, o una reserva aprobada. El índice de actividad sólo dice cuánto se movió alguien: nunca lo presentes como quién rinde mejor.",
    "- Si `mejor_vendedor` es null, no nombres a nadie como el mejor y explica por qué en una línea: `ventas_no_disponibles`, o que nadie vendió en el periodo.",
    "- Si hay `sin_coincidir`, dilo: son ventas con un nombre escrito a mano que no se pudo atribuir a nadie, y podrían cambiar el ranking.",
    "- Los mensajes se cuentan a quien tiene hoy el chat, y `mensajes` en null significa que no se sabe, no que sean cero.",
    "- Para un asesor concreto ('¿cómo va Golden 1?', '¿cuántos mensajes le llegaron a Sara?') pasa su nombre en `asesor`.",
    "La combi (`combi_del_dia`):",
    "- Distingue las salidas creadas de `programados_sin_pasajeros`. Si `horarios_provisionales` es true, aclara que esos horarios fijos todavía son provisionales.",
  ].join("\n");
}

async function llamar(apiKey: string, model: string, mensajes: MensajeOpenAi[], herramientas: readonly unknown[]) {
  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: mensajes,
        tools: herramientas,
        tool_choice: "auto",
        max_completion_tokens: 1400,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    const tiempo = err instanceof Error && err.name === "TimeoutError";
    throw new ErrorAsistente(tiempo ? "El asistente tardó demasiado." : "No se pudo contactar al proveedor de IA.", tiempo ? "tiempo" : "proveedor");
  }
  if (!res.ok) {
    const cuerpo = await res.text().catch(() => "");
    console.error("[assistant] OpenAI error", res.status, cuerpo.slice(0, 400));
    throw new ErrorAsistente(`El proveedor de IA respondió ${res.status}.`, "proveedor");
  }
  const data = (await res.json()) as { choices?: { message?: MensajeOpenAi }[] };
  const mensaje = data.choices?.[0]?.message;
  if (!mensaje) throw new ErrorAsistente("Respuesta vacía del proveedor de IA.", "proveedor");
  return mensaje;
}

/**
 * Responde una pregunta con el historial reciente del hilo.
 * @param historial del más viejo al más nuevo, sin la pregunta actual
 */
export async function responder(
  ctx: ContextoAsistente,
  historial: { role: "user" | "assistant"; content: string }[],
  pregunta: string,
): Promise<{ texto: string; acciones: Accion[]; adjuntos: AdjuntoMaterial[]; envios: EnvioPropuesto[] }> {
  const acciones: Accion[] = [];
  const adjuntos: AdjuntoMaterial[] = [];
  const envios: EnvioPropuesto[] = [];
  const texto = await conversar({
    db: ctx.db,
    accountId: ctx.accountId,
    sistema: instrucciones(ctx),
    herramientas: HERRAMIENTAS,
    ejecutar: async (nombre, argumentos) => {
      const r = await ejecutarHerramienta(ctx, nombre, argumentos);
      if (r.accion) acciones.push(r.accion);
      if (r.adjuntos) adjuntos.push(...r.adjuntos);
      if (r.envio) envios.push(r.envio);
      return r.datos;
    },
    historial,
    pregunta,
  });
  return { texto, acciones, adjuntos, envios };
}

/**
 * La vuelta de cualquier asistente: instrucciones, herramientas propias y
 * su propio hilo. La usan el Asistente Golden y los modos de WhatsApp.
 */
export async function conversar(opciones: {
  db: SupabaseClient;
  accountId: string;
  sistema: string;
  herramientas: readonly unknown[];
  ejecutar: (nombre: string, argumentos: string) => Promise<unknown>;
  historial: { role: "user" | "assistant"; content: string }[];
  pregunta: string;
}): Promise<string> {
  const llave = await credenciales(opciones.db, opciones.accountId);
  if (!llave) {
    throw new ErrorAsistente("Falta OPENAI_API_KEY en el servidor del CRM.", "sin_llave");
  }

  const mensajes: MensajeOpenAi[] = [
    { role: "system", content: opciones.sistema },
    ...opciones.historial.slice(-MENSAJES_DE_MEMORIA).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opciones.pregunta },
  ];

  for (let vuelta = 0; vuelta < VUELTAS_MAXIMAS; vuelta += 1) {
    const respuesta = await llamar(llave.apiKey, llave.model, mensajes, opciones.herramientas);
    const llamadas = respuesta.tool_calls ?? [];
    if (!llamadas.length) {
      return (respuesta.content ?? "").trim() || "No tengo una respuesta para eso.";
    }

    mensajes.push({ role: "assistant", content: respuesta.content ?? null, tool_calls: llamadas });
    for (const llamada of llamadas) {
      const datos = await opciones.ejecutar(llamada.function.name, llamada.function.arguments);
      mensajes.push({
        role: "tool",
        tool_call_id: llamada.id,
        content: JSON.stringify(datos).slice(0, 12_000),
      });
    }
  }

  return "Me enredé con tantas consultas. ¿Me lo preguntas de otra forma, más concreto?";
}
