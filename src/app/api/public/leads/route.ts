import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function OPTIONS() {
  return new NextResponse("ok", {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, email, phone, country, using_software, software_name, timeline } = body;

    if (!name || !email || !phone) {
      return new NextResponse(
        JSON.stringify({ error: "Faltan campos obligatorios (nombre, email o WhatsApp)" }),
        {
          status: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Initialize Supabase Admin client
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    // 1. Resolve Account for "Aurex"
    let accountId = null;
    let ownerUserId = null;

    // Search for account named 'Aurex'
    const { data: account } = await supabaseAdmin
      .from("accounts")
      .select("id, owner_user_id")
      .eq("name", "Aurex")
      .limit(1)
      .maybeSingle();

    if (account) {
      accountId = account.id;
      ownerUserId = account.owner_user_id;
    } else {
      // Fallback: search for first account
      const { data: fallback } = await supabaseAdmin
        .from("accounts")
        .select("id, owner_user_id")
        .limit(1)
        .maybeSingle();
      
      if (fallback) {
        accountId = fallback.id;
        ownerUserId = fallback.owner_user_id;
      }
    }

    if (!accountId || !ownerUserId) {
      return new NextResponse(
        JSON.stringify({ error: "No se encontró ninguna cuenta activa en el CRM para asociar el lead" }),
        {
          status: 500,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
          },
        }
      );
    }

    // 2. Check if contact already exists in this account (avoid duplicates by email or phone)
    const { data: existingContact } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("account_id", accountId)
      .or(`email.eq.${email.toLowerCase().trim()},phone.eq.${phone.trim()}`)
      .limit(1)
      .maybeSingle();

    let contactId = null;

    if (existingContact) {
      contactId = existingContact.id;
      // Update contact details
      await supabaseAdmin
        .from("contacts")
        .update({
          name,
          updated_at: new Date().toISOString()
        })
        .eq("id", contactId);
    } else {
      // Create new contact
      const { data: newContact, error: createError } = await supabaseAdmin
        .from("contacts")
        .insert({
          name,
          email: email.toLowerCase().trim(),
          phone: phone.trim(),
          account_id: accountId,
          user_id: ownerUserId
        })
        .select("id")
        .single();

      if (createError) throw createError;
      contactId = newContact.id;
    }

    // 3. Create Note with Form Questions/Details
    const noteText = `📌 Registro de Demostración Exclusiva (Aurex AI)
- País: ${country || "No especificado"}
- ¿Usa software de gestión?: ${using_software || "No"}
${using_software === "Sí" && software_name ? `- Software actual: ${software_name}` : ""}
- Tiempo de implementación: ${timeline || "Solo investigando"}`;

    await supabaseAdmin.from("contact_notes").insert({
      contact_id: contactId,
      user_id: ownerUserId,
      note_text: noteText
    });

    // 4. Create or Update Conversation row to trigger CRM inbox alert
    const { data: existingConv } = await supabaseAdmin
      .from("conversations")
      .select("id, unread_count")
      .eq("contact_id", contactId)
      .eq("account_id", accountId)
      .limit(1)
      .maybeSingle();

    if (existingConv) {
      await supabaseAdmin
        .from("conversations")
        .update({
          last_message_text: "Nuevo registro de demo Aurex",
          last_message_at: new Date().toISOString(),
          unread_count: (existingConv.unread_count || 0) + 1,
          status: "open",
          updated_at: new Date().toISOString()
        })
        .eq("id", existingConv.id);
    } else {
      await supabaseAdmin.from("conversations").insert({
        account_id: accountId,
        user_id: ownerUserId,
        contact_id: contactId,
        status: "open",
        last_message_text: "Nuevo registro de demo Aurex",
        last_message_at: new Date().toISOString(),
        unread_count: 1
      });
    }

    return new NextResponse(
      JSON.stringify({ success: true, message: "Lead registrado exitosamente en el CRM", contactId }),
      {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error: any) {
    console.error("[API public/leads] Exception:", error);
    return new NextResponse(
      JSON.stringify({ error: "Error interno del servidor", details: error.message }),
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      }
    );
  }
}
