// ============================================================
// Lo que el modo Caja escribe por WhatsApp: montos, el resumen del día,
// el borrador que se confirma con un botón y los comandos (/menu, /caja…).
// Sin red ni base de datos, para probarlo solo.
// ============================================================

export const MARCA_CAJA = "💼 Caja";

export type Modo = "caja" | "app" | "legal";

/** Cada respuesta empieza con la marca de su modo, para saber dónde se está. */
export const MODOS: Record<Modo, { marca: string; boton: string; nombre: string }> = {
  caja: { marca: MARCA_CAJA, boton: "💼 Golden Caja", nombre: "Golden Caja" },
  app: { marca: "🏠 App", boton: "🏠 Golden App", nombre: "Golden App" },
  legal: { marca: "⚖️ Legal", boton: "⚖️ Golden Legal", nombre: "Golden Legal" },
};

/** El Asistente Golden escribe **negrita** de Markdown; WhatsApp la quiere con un asterisco. */
export function aWhatsApp(texto: string): string {
  return texto.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#{1,6}\s+/gm, "");
}

export const METODOS = {
  cash: "Efectivo",
  yape: "Yape",
  plin: "Plin",
  card: "Tarjeta",
  transfer: "Transferencia",
} as const;
export type Metodo = keyof typeof METODOS;

export const CATEGORIAS = {
  movilidad: "Movilidad",
  materiales: "Materiales",
  alimentacion: "Alimentación",
  servicios: "Servicios",
  operaciones: "Operaciones",
  varios: "Varios",
} as const;
export type Categoria = keyof typeof CATEGORIAS;

const formatoSoles = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 12050 → "S/ 120.50". Los decimales se omiten cuando son cero. */
export function soles(centimos: number): string {
  const texto = formatoSoles.format(Math.abs(centimos) / 100).replace(/[.,]00$/, "");
  return `${centimos < 0 ? "−" : ""}S/ ${texto}`;
}

/** Día de hoy en Lima, AAAA-MM-DD. */
export function hoyEnLima(ahora = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(ahora);
}

export interface CajaDelDia {
  name: string;
  icon: string | null;
  balanceCents: number;
  inCents: number;
  outCents: number;
  transferInCents: number;
  transferOutCents: number;
  count: number;
  largeExpenses: { amountCents: number; concept: string; actorName: string; justification: string | null }[];
  closure: { diffCents: number; reason: string | null; actorName: string } | null;
  pendingReplenishments: { amountCents: number; reason: string; requesterName: string }[];
}

export interface VistaDelDia {
  day: string;
  isOwner: boolean;
  accountName: string | null;
  boxes: CajaDelDia[];
}

/**
 * El resumen del día de todas las cajas que la persona puede ver: lo que
 * entró y salió, el saldo, los gastos grandes, los cierres con diferencia
 * o sin hacer y las reposiciones pendientes.
 */
export function resumenDelDia(vista: VistaDelDia, saludo?: string): string {
  if (!vista.boxes.length) return "No tienes ninguna caja a la vista.";
  const lineas: string[] = [];
  if (saludo) lineas.push(saludo, "");

  let entro = 0;
  let salio = 0;
  let saldo = 0;
  for (const caja of vista.boxes) {
    entro += caja.inCents;
    salio += caja.outCents;
    saldo += caja.balanceCents;
    const icono = caja.icon ? `${caja.icon} ` : "";
    const movio = caja.count
      ? `entró ${soles(caja.inCents)} · salió ${soles(caja.outCents)}`
      : "sin movimientos";
    lineas.push(`${icono}*${caja.name}*: ${movio}. Saldo ${soles(caja.balanceCents)}.`);
    if (caja.transferInCents || caja.transferOutCents) {
      const pases = [
        caja.transferInCents ? `recibió ${soles(caja.transferInCents)}` : "",
        caja.transferOutCents ? `pasó ${soles(caja.transferOutCents)}` : "",
      ].filter(Boolean);
      lineas.push(`   Pases entre cajas: ${pases.join(", ")}.`);
    }
    for (const g of caja.largeExpenses) {
      lineas.push(`   ⚠️ Gasto grande: ${soles(g.amountCents)} en ${g.concept} (${g.actorName})${g.justification ? `: ${g.justification}` : ""}`);
    }
    if (!caja.closure) {
      if (caja.count) lineas.push("   🔓 Todavía no cierra la caja.");
    } else if (caja.closure.diffCents !== 0) {
      const tipo = caja.closure.diffCents < 0 ? "faltante" : "sobrante";
      lineas.push(`   ❗ Cerró con ${tipo} de ${soles(Math.abs(caja.closure.diffCents))}${caja.closure.reason ? `: ${caja.closure.reason}` : ""}`);
    }
    for (const r of caja.pendingReplenishments) {
      lineas.push(`   🙋 ${r.requesterName} pide reposición de ${soles(r.amountCents)}: ${r.reason}`);
    }
  }

  if (vista.boxes.length > 1) {
    lineas.push("", `*Total*: entró ${soles(entro)} · salió ${soles(salio)}. Saldo de todas: ${soles(saldo)}.`);
  }
  return lineas.join("\n");
}

export interface Borrador {
  caja: string;
  kind: "income" | "expense";
  amountCents: number;
  concept: string;
  paymentMethod: Metodo;
  category: Categoria | null;
  justification: string | null;
}

/** "−S/ 120 en Restaurante · Gas · Yape" */
export function lineaDeMovimiento(b: Borrador): string {
  const signo = b.kind === "expense" ? "−" : "+";
  const partes = [`${signo}${soles(b.amountCents)} en ${b.caja}`, b.concept, METODOS[b.paymentMethod]];
  if (b.category) partes.push(CATEGORIAS[b.category]);
  return partes.join(" · ");
}

export function textoDelBorrador(b: Borrador): string {
  const tipo = b.kind === "expense" ? "Gasto" : "Ingreso";
  const lineas = [`${MARCA_CAJA}`, `¿Guardo este ${tipo.toLowerCase()}?`, "", lineaDeMovimiento(b)];
  if (b.justification) lineas.push(`Motivo: ${b.justification}`);
  lineas.push("", "Toca *Sí, guardar* para que quede registrado.");
  return lineas.join("\n");
}

export type Comando = "menu" | "caja" | "app" | "legal" | "cliente" | "salir" | "olvidar" | "resumen";

const COMANDOS: Record<string, Comando> = {
  menu: "menu",
  "menú": "menu",
  caja: "caja",
  app: "app",
  legal: "legal",
  cliente: "cliente",
  salir: "salir",
  olvidar: "olvidar",
  resumen: "resumen",
};

/** "/caja", "/Menú " → el comando; cualquier otra cosa → null. */
export function leerComando(texto: string): Comando | null {
  const m = texto.trim().toLowerCase().match(/^\/(\S+)$/);
  return m ? (COMANDOS[m[1]] ?? null) : null;
}

const SALUDOS = /^(hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|ola|que tal)[\s!.,¡]*$/;

/** Un saludo suelto no se le pasa a la IA: basta con el resumen del día. */
export function esSoloSaludo(texto: string): boolean {
  const limpio = texto.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return SALUDOS.test(limpio);
}

/** WhatsApp corta en 4096 caracteres; los botones, en 1024. */
export function recortar(texto: string, maximo: number): string {
  return texto.length <= maximo ? texto : `${texto.slice(0, maximo - 1)}…`;
}
