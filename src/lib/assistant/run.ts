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
    "Cómo leer el interés de un cliente (esto importa: aquí se pierden ventas):",
    "- Juzga SIEMPRE por `dijo_el_cliente`, que son sus propias palabras. `ultimo_mensaje` es la última línea del hilo y muchas veces es la respuesta de la IA, no la del cliente: no concluyas nada de ahí.",
    "- Cuenta como interés, aunque el mensaje sea corto: preguntar precio, ubicación, metraje, disponibilidad o financiamiento; pedir información o el brochure; dejar su nombre, su DNI o su correo; pedir una visita o una hora; mandar una foto o un voucher; decir que está viendo o comparando. Un 'hola' suelto no lo es; 'hola, quiero información' sí.",
    "- Si sólo tienes un saludo y nada más, dilo tal cual: 'sólo saludó, todavía no sabemos qué busca', y propón la pregunta que conviene hacerle. No lo llames 'sin interés'.",
    "- Antes de decir que alguien no tiene interés, revisa su hilo con resumen_cliente. Si no lo revisaste, no lo afirmes.",
    "- Cuando te pidan a quién seguir, ordena por señales de interés y por quién quedó sin respuesta, y di en una línea por qué cada uno está en la lista, citando lo que dijo.",
    "- Antes de agendar, asegúrate de tener cliente, día, hora y tipo (videollamada, presencial = visita, o llamada). Si la persona ya lo dijo todo claramente, agenda; si falta algo, pregunta. Después confirma lo que quedó agendado.",
    "- Si piden redactar un mensaje para un cliente, escríbelo listo para mandar por WhatsApp: corto, cálido, en español de Perú, sin prometer precios ni condiciones que no estén en los datos.",
    "- Responde corto y fácil de leer en un celular: frases breves, listas con '- ' cuando haya varias cosas, montos con su moneda (S/ para soles). Usa **negrita** sólo para lo importante.",
    "- Si una herramienta dice que falta una migración, explícalo en una línea y sigue con lo que sí se pueda.",
  ].join("\n");
}

async function llamar(apiKey: string, model: string, mensajes: MensajeOpenAi[]) {
  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: mensajes,
        tools: HERRAMIENTAS,
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
): Promise<{ texto: string; acciones: Accion[] }> {
  const llave = await credenciales(ctx.db, ctx.accountId);
  if (!llave) {
    throw new ErrorAsistente("Falta OPENAI_API_KEY en el servidor del CRM.", "sin_llave");
  }

  const mensajes: MensajeOpenAi[] = [
    { role: "system", content: instrucciones(ctx) },
    ...historial.slice(-MENSAJES_DE_MEMORIA).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: pregunta },
  ];
  const acciones: Accion[] = [];

  for (let vuelta = 0; vuelta < VUELTAS_MAXIMAS; vuelta += 1) {
    const respuesta = await llamar(llave.apiKey, llave.model, mensajes);
    const llamadas = respuesta.tool_calls ?? [];
    if (!llamadas.length) {
      return { texto: (respuesta.content ?? "").trim() || "No tengo una respuesta para eso.", acciones };
    }

    mensajes.push({ role: "assistant", content: respuesta.content ?? null, tool_calls: llamadas });
    for (const llamada of llamadas) {
      const r = await ejecutarHerramienta(ctx, llamada.function.name, llamada.function.arguments);
      if (r.accion) acciones.push(r.accion);
      mensajes.push({
        role: "tool",
        tool_call_id: llamada.id,
        content: JSON.stringify(r.datos).slice(0, 12_000),
      });
    }
  }

  return {
    texto: "Me enredé con tantas consultas. ¿Me lo preguntas de otra forma, más concreto?",
    acciones,
  };
}
