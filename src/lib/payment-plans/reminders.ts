// ============================================================
// Recordatorios de cuota (E7, migración 052).
//
// Corre dentro de /api/cron/reminders (cada ~5 minutos). Sólo manda en
// horario decente de Lima (9:00 a 20:00): nadie quiere un "tu cuota
// vence" a las 6 de la mañana.
//
// Para cada cuota pendiente que vence en 3 días, hoy, o venció hace 3:
//   1. reclama el aviso en `installment_reminders` (UNIQUE: si ya está,
//      no se manda de nuevo);
//   2. si el cliente usa la app, le deja el recordatorio en su chat y le
//      suena el celular — gratis, funciona hoy;
//   3. si hay plantilla de WhatsApp configurada (WHATSAPP_CUOTA_TEMPLATE)
//      y el cliente no está en la app, se la manda por WhatsApp. Sin
//      método de pago en Meta, Meta la rechaza: queda anotado el error.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { notifyClient } from "@/lib/push/send";
import { engineSendTemplate } from "@/lib/automations/meta-send";
import { insertarMensaje } from "@/lib/channels";

type Tipo = "antes" | "hoy" | "vencida";

const DIAS: Record<Tipo, number> = { antes: 3, hoy: 0, vencida: -3 };

const hoyLima = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const horaLima = () =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Lima", hour: "numeric", hour12: false }).format(new Date()));

function sumarDias(fecha: string, dias: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  const f = new Date(Date.UTC(a, m - 1, d + dias));
  return f.toISOString().slice(0, 10);
}

const dinero = (monto: number, moneda: string) =>
  `${moneda === "PEN" ? "S/" : moneda} ${Number(monto).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fechaLarga = (iso: string) =>
  new Date(`${iso}T12:00:00-05:00`).toLocaleDateString("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" });

function textoDe(tipo: Tipo, nombre: string, numero: number, monto: string, vence: string): string {
  const hola = nombre ? `Hola ${nombre}, ` : "Hola, ";
  if (tipo === "antes") return `${hola}te recordamos que tu cuota N° ${numero} de ${monto} vence el ${vence}. Puedes subir tu voucher en la pestaña Voucher.`;
  if (tipo === "hoy") return `${hola}hoy vence tu cuota N° ${numero} de ${monto}. Cuando pagues, sube el voucher en la pestaña Voucher y cobranzas lo revisa.`;
  return `${hola}tu cuota N° ${numero} de ${monto} venció el ${vence} y aún figura pendiente. Si ya pagaste, sube el voucher; si necesitas ayuda, escríbenos por aquí.`;
}

interface Cuota {
  id: string;
  account_id: string;
  number: number;
  amount: number;
  due_date: string;
  voucher_path?: string | null;
  plan: {
    currency: string;
    status: string;
    contact: { id: string; name: string | null; dni: string | null } | null;
  } | null;
}

export async function recordatoriosDeCuotas(db: SupabaseClient): Promise<{ enviados: number; omitidos?: string }> {
  const hora = horaLima();
  if (hora < 9 || hora >= 20) return { enviados: 0, omitidos: "fuera de horario" };

  const hoy = hoyLima();
  const plantilla = process.env.WHATSAPP_CUOTA_TEMPLATE?.trim() || "";
  const idioma = process.env.WHATSAPP_CUOTA_TEMPLATE_LANG?.trim() || "es";
  let enviados = 0;

  for (const tipo of Object.keys(DIAS) as Tipo[]) {
    const fecha = sumarDias(hoy, DIAS[tipo]);
    const { data, error } = await db
      .from("installments")
      .select("id, account_id, number, amount, due_date, voucher_path, plan:payment_plans!inner(currency, status, contact:contacts(id, name, dni))")
      .eq("status", "pendiente")
      .eq("due_date", fecha)
      .eq("plan.status", "activo")
      .limit(300);
    if (error) {
      // Sin la 047 no existe voucher_path; sin la 052 fallará el reclamo.
      console.error("[cuotas] reminder lookup failed:", error.message);
      return { enviados, omitidos: error.message };
    }

    for (const c of (data ?? []) as unknown as Cuota[]) {
      const contacto = c.plan?.contact;
      if (!contacto) continue;
      // Si ya dejó el voucher, no se le cobra: cobranzas lo está revisando.
      if (c.voucher_path) continue;

      const { data: cuenta } = await db
        .from("accounts")
        .select("payment_reminders_enabled, client_portal_enabled, owner_user_id")
        .eq("id", c.account_id)
        .maybeSingle();
      if (cuenta && cuenta.payment_reminders_enabled === false) continue;

      // El reclamo: si otra pasada ya lo mandó, aquí se detiene.
      const { data: reclamo, error: errReclamo } = await db
        .from("installment_reminders")
        .insert({ account_id: c.account_id, installment_id: c.id, kind: tipo })
        .select("id")
        .single();
      if (errReclamo || !reclamo) {
        if ((errReclamo as { code?: string } | null)?.code !== "23505") {
          console.error("[cuotas] could not claim reminder:", errReclamo?.message);
          return { enviados, omitidos: errReclamo?.message };
        }
        continue;
      }

      const nombre = (contacto.name ?? "").trim().split(/\s+/)[0] ?? "";
      const monto = dinero(c.amount, c.plan?.currency ?? "PEN");
      const vence = fechaLarga(c.due_date);
      const texto = textoDe(tipo, nombre, c.number, monto, vence);
      const canales: string[] = [];
      let fallo: string | null = null;

      const { data: conv } = await db
        .from("conversations")
        .select("id, channel")
        .eq("contact_id", contacto.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const usaLaApp = Boolean(contacto.dni && cuenta?.client_portal_enabled);
      if (usaLaApp) {
        if (conv) {
          await insertarMensaje(db, {
            conversation_id: conv.id,
            sender_type: "bot",
            content_type: "text",
            content_text: texto,
            message_id: null,
            status: "sent",
            channel: "app",
          }, "id");
          await db
            .from("conversations")
            .update({ last_message_text: texto, last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("id", conv.id);
        }
        await notifyClient(db, {
          contactId: contacto.id,
          title: tipo === "vencida" ? "Cuota vencida" : "Recordatorio de cuota",
          body: texto,
        }).catch(() => {});
        canales.push("app");
      }

      // WhatsApp sólo para quien no está en la app, y sólo con plantilla:
      // fuera de la ventana de 24 h Meta no deja mandar texto libre.
      if (!usaLaApp && plantilla && conv && cuenta?.owner_user_id) {
        try {
          await engineSendTemplate({
            accountId: c.account_id,
            userId: cuenta.owner_user_id,
            conversationId: conv.id,
            contactId: contacto.id,
            templateName: plantilla,
            language: idioma,
            params: [nombre || "cliente", String(c.number), monto, vence],
          });
          canales.push("whatsapp");
        } catch (err) {
          fallo = err instanceof Error ? err.message.slice(0, 300) : "error";
        }
      }

      await db
        .from("installment_reminders")
        .update({ channels: canales.join("+") || "ninguno", error: fallo })
        .eq("id", reclamo.id);
      if (canales.length) enviados += 1;
    }
  }

  return { enviados };
}
