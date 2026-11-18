# Líneas de WhatsApp por cuenta - Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Al aprobar:** copiar este archivo a `CRM WIO\wacrm-v5\docs\superpowers\plans\2026-11-18-lineas-whatsapp-por-cuenta.md` (repo Wio7/WIO_CRM) y anotar el plan en el vault (`Proyectos/Wio CRM.md`, `Diario/2026-11-18.md`).

**Goal:** Que una cuenta de Wio CRM tenga varios números de WhatsApp ("líneas": Ventas, Legal, Cobranzas, Posventa), cada una con su nombre y logo en la bandeja, visibles solo para el área que corresponde, con traspaso de conversaciones entre áreas y, al final, una IA por línea.

**Architecture:** `whatsapp_config` pasa a ser la tabla de líneas (se quita `UNIQUE(account_id)`, se agregan nombre, área, logo y línea principal). Cada conversación guarda su `line_id` y su `area`; todo envío sale por la línea de la conversación; lo que llega ya se enruta por `phone_number_id`. Una cuenta con una sola línea se comporta exactamente como hoy (línea principal por defecto).

**Tech Stack:** Next.js + Supabase (RLS, migraciones `supabase/migrations`), Vitest (proyecto `unit` y proyecto `database` con PGlite), Meta Graph API.

**Spec:** decisiones de Bryce del 2026-11-18 (abajo) y el mapa del código hecho ese día (citas `archivo:línea` de esta sesión).

## Decisiones de Bryce (2026-11-18)
- Traspaso entre áreas: **mismo número**; cambia el área y el equipo que atiende. El cliente sigue con el mismo WhatsApp.
- Visibilidad: **por área de la persona**; gerencia y dueños ven todas las líneas.
- Entrega en **3 fases**, cada una publicada y probada: (1) líneas + bandeja + permisos, (2) traspaso entre áreas, (3) IA por línea.
- Golden Habitat: líneas con número propio = **Legal, Cobranzas, Posventa** (+ la actual, que se asume Ventas: confirmar). **Administración y Gerencia no tienen número**: solo reciben traspasos; gerencia ve todo.
- Números de áreas = solo API (sin app en celular); el de ventas puede ser coexistencia.

## Global Constraints
- Interfaz en español; nada de la marca "Wio Suite" visible al cliente.
- Todo va por PR a `main` con CI en verde (main está protegido) y se publica a producción; sin previews como entrega.
- Todo SQL se entrega a Bryce **completo en el chat, con pasos numerados** (él lo ejecuta en Supabase). Las migraciones del repo llevan el número `103` en adelante (la última en `supabase/migrations` es `097_gerencia.sql`; existen SQL sueltos `098`-`102` en `CRM WIO\`; confirmar contra la base real antes de numerar).
- Vista web y vista de celular separadas (no estirar una sola).
- Meta (documentación consultada 2026-11-18): tope de **2 números** por portafolio sin verificar, **20** con verificación; los límites de envío son del **portafolio**, la calidad es **por número**.
- Una cuenta con una sola línea no cambia de comportamiento.

## Review Focus
- Un mismo contacto que escribe a dos líneas: **dos conversaciones separadas** (no un hilo mezclado); `contacts` sigue siendo uno por teléfono por cuenta.
- Cuenta con una línea (todas las actuales): los mismos resultados que antes en envío, bandeja y webhook.
- Borrar o desconectar una línea con conversaciones: no se borran las conversaciones; quedan con `line_id` nulo/inactivo y avisan.
- Persona con conversación asignada que pierde el área (por traspaso): deja de verla y no queda huérfana (se reasigna o queda sin dueño en el área nueva).
- Dos líneas no pueden reclamar el mismo `phone_number_id`; el eco de coexistencia de la línea B nunca escribe en hilos de la línea A.
- Plantillas/difusiones de una línea cuyo WABA es otro: no se envía con la plantilla de otra cuenta de WhatsApp.

---

## FASE 1 - Varias líneas por cuenta, bandeja y permisos

### Task 1: Migración 103 (líneas, hilos por línea, área `posventa`, acceso por área)
**Files:**
- Create: `supabase/migrations/103_whatsapp_lineas.sql`
- Test: `src/lib/whatsapp/lineas-103.database.test.ts` (patrón de `src/lib/handoffs/handoffs-085.database.test.ts`: PGlite que ejecuta las migraciones)

**Interfaces:**
- Produces: columnas `whatsapp_config.line_name text NOT NULL DEFAULT 'Principal'`, `area text` (CHECK con los valores de `profiles.area` de 092:43 + `'posventa'`), `logo_url text`, `is_primary boolean NOT NULL DEFAULT false`, `sort_order int NOT NULL DEFAULT 0`; índice único parcial `whatsapp_config_one_primary` sobre `(account_id) WHERE is_primary`; `conversations.line_id uuid REFERENCES whatsapp_config(id) ON DELETE SET NULL`, `conversations.area text`; función `can_access_conversation(p_account uuid, p_assigned uuid, p_area text) RETURNS boolean`.

- [ ] **Step 1: Test que falla.** Casos: (a) se pueden insertar dos filas en `whatsapp_config` de la misma cuenta con distinto `phone_number_id`; (b) el mismo `phone_number_id` en dos filas falla (013); (c) solo una `is_primary` por cuenta; (d) `profiles.area = 'posventa'` y la invitación con `area = 'posventa'` son válidas; (e) con `can_access_conversation(acct, asignado, 'legal')`: owner y admin sin área ven todo; usuario del área `gerencia` ve todo; usuario del área `legal` ve `legal` y no `cobranzas`; `agent` con `agents_see_only_assigned` solo lo asignado.
- [ ] **Step 2:** correr `npx vitest run --project database src/lib/whatsapp/lineas-103.database.test.ts` → FALLA.
- [ ] **Step 3: Migración idempotente.** Quitar `whatsapp_config_account_id_key`; agregar las columnas; rellenar `is_primary = true` y `line_name = 'Principal'` en la única fila de cada cuenta; `conversations`: agregar `line_id`/`area`, rellenar `line_id` con la línea principal de la cuenta y `area` con `whatsapp_config.area` (nulo si no hay); ampliar los CHECK de `profiles.area` y `account_invitations.area` (nombres exactos en 092:43 y 091:49); crear la sobrecarga de 3 argumentos de `can_access_conversation` **conservando** la lógica vigente de 055:41-79/062 y añadiendo: sin área en la conversación o usuario con área `gerencia`/owner/admin sin área → como hoy; con `p_area` → el usuario debe tener esa área. Recrear las políticas `conversations_select` y `messages_select` (039:86-105) llamándola con `c.area`.
- [ ] **Step 4:** el test pasa; correr también las pruebas de base existentes (`npx vitest run --project database`).
- [ ] **Step 5: Commit** `feat(whatsapp): líneas por cuenta, hilo por línea y acceso por área`.

### Task 2: Ayudante de líneas
**Files:**
- Create: `src/lib/whatsapp/lines.ts`
- Test: `src/lib/whatsapp/lines.test.ts`

**Interfaces:**
- Produces: `type WhatsAppLine = { id: string; account_id: string; phone_number_id: string; waba_id: string | null; line_name: string; area: string | null; logo_url: string | null; is_primary: boolean; status: string; access_token: string; user_id: string }`; `listLines(db, accountId): Promise<WhatsAppLine[]>`; `getPrimaryLine(db, accountId): Promise<WhatsAppLine | null>`; `getLineForConversation(db, conversationId): Promise<WhatsAppLine | null>` (usa `conversations.line_id`; si es nulo cae a la principal de la cuenta); `getLineByPhoneNumberId(db, phoneNumberId): Promise<WhatsAppLine | null>`.

- [ ] **Step 1:** pruebas con el mock por tabla de `send/route.test.ts:31-60`: conversación con `line_id` devuelve esa línea; sin `line_id` devuelve la principal; cuenta sin líneas devuelve `null`.
- [ ] **Step 2:** correr → falla. **Step 3:** implementar las cuatro funciones (consulta por `account_id`, ordenar por `sort_order`). **Step 4:** correr → pasa. **Step 5:** commit.

### Task 3: Webhook entrante por línea
**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (`findOrCreateConversation` `:1017-1057`, `processMessage` `:609-649`, búsqueda de config `:298-348`)
- Modify: `src/lib/whatsapp/coexistence-sync-handler.ts:15-18` (solo verificar que sigue resolviendo por `phone_number_id`; ya devuelve exactamente una fila)
- Test: `src/app/api/whatsapp/webhook/route.test.ts`

**Interfaces:**
- Consumes: `getLineByPhoneNumberId` (Task 2).
- Produces: `findOrCreateConversation(accountId, userId, contactId, line: { id: string; area: string | null })`: busca por `account_id + contact_id + line_id`, inserta con `line_id` y `area = line.area`.

- [ ] **Step 1:** pruebas: (a) mensaje del contacto X a la línea A y luego a la B crea **dos** conversaciones con su `line_id`; (b) cuenta con una línea sigue creando una sola; (c) el eco de la línea B no toca hilos de la A.
- [ ] **Step 2-4:** implementar con el cambio de firma; el contacto se sigue buscando por cuenta + teléfono (`findOrCreateContact` `:941-1015` no cambia). Conversaciones antiguas con `line_id` nulo se reutilizan solo para la línea principal (compatibilidad).
- [ ] **Step 5:** commit.

### Task 4: Todo envío sale por la línea de la conversación
**Files:**
- Modify: `src/lib/whatsapp/send-message.ts:166,332-336,362,432-458`; `src/lib/flows/meta-send.ts:63,156,244,265,373,383,417`; `src/lib/automations/meta-send.ts:87`; `src/lib/ai/auto-reply.ts:234,388`; `src/app/api/whatsapp/media/[mediaId]/route.ts:62`; `src/app/api/whatsapp/react/route.ts:113`; `src/lib/api/v1/contacts.ts:77`
- Test: `src/lib/whatsapp/send-message.test.ts` y pruebas existentes de cada archivo

**Interfaces:**
- Consumes: `getLineForConversation`, `getPrimaryLine`.
- Produces: cada punto de envío con conversación usa `line.phone_number_id` y `line.access_token`; los que no tienen conversación (API v1, difusiones) aceptan `line_id` opcional y caen a la principal.

- [ ] **Step 1:** prueba: con dos líneas, responder en una conversación de la línea B llama a Graph con el `phone_number_id` de B; la de la A, con el de A; una cuenta con una línea no cambia.
- [ ] **Step 2-4:** reemplazar las consultas `.eq('account_id').single()` por los ayudantes. **Step 5:** commit.

### Task 5: API de configuración y alta por línea
**Files:**
- Modify: `src/app/api/whatsapp/config/route.ts` (GET `:89-91`, POST `:214-399`, DELETE `:472-474`); `src/app/api/whatsapp/embedded-signup/route.ts` (upsert `:39-51`, comprobación de número reclamado, `onConflict`)
- Test: `src/app/api/whatsapp/embedded-signup/route.test.ts`, prueba nueva de `config/route`

**Interfaces:**
- Produces: `GET /api/whatsapp/config` → `{ lines: WhatsAppLine[] }`; `POST` y `DELETE` reciben `line_id` opcional (sin él, actúan sobre la principal); `embedded-signup` hace upsert por `phone_number_id` (no por `account_id`), crea la fila nueva si el número no existe, y marca `is_primary` solo si la cuenta no tenía línea; `DELETE` desconecta una línea sin borrar conversaciones.

- [ ] **Step 1:** pruebas: segundo número en la misma cuenta crea una fila nueva; el mismo número ya usado por otra cuenta da 409; borrar una línea deja `conversations.line_id` en nulo; el tope de líneas de la cuenta es configurable y por defecto avisa en 2 si el portafolio no está verificado (solo aviso, no bloquea).
- [ ] **Step 2-4:** implementar. **Step 5:** commit.

### Task 6: Pantalla de WhatsApp con varias líneas
**Files:**
- Modify: `src/components/settings/whatsapp-config.tsx:39,53-165`; `src/components/settings/whatsapp-embedded-signup.tsx:39`
- Test: `src/components/settings/whatsapp-config.test.tsx` (si no existe, crear con el patrón de las pruebas de componentes del repo)

**Interfaces:**
- Consumes: `GET /api/whatsapp/config` → `lines`.
- Produces: lista de líneas (logo, nombre, área, número, estado) con "Agregar línea" (botón de Embedded Signup existente) y "Editar" (nombre, área, logo); el formulario manual con token queda como opción avanzada por línea; vista web y vista de celular separadas.

- [ ] **Step 1:** prueba: con 2 líneas se muestran 2 filas y "Agregar línea"; con 1 línea se ve como hoy.
- [ ] **Step 2-4:** implementar (reemplazar `maybeSingle` `:105-109`). **Step 5:** commit.

### Task 7: Bandeja con línea visible y filtro
**Files:**
- Modify: `src/components/inbox/conversation-list.tsx:47-53,93-97,177-207`; `src/components/inbox/message-thread.tsx` (encabezado); `src/types/index.ts:61` (`MemberArea` + `'posventa'`); `src/components/settings/members-tab.tsx` (lista de áreas)
- Test: pruebas de los componentes tocados

**Interfaces:**
- Consumes: `conversations.line_id`, `conversations.area`, líneas del Task 5.
- Produces: etiqueta (logo + nombre de la línea) en cada conversación y en el encabezado del hilo; filtro "Línea" junto a los de estado/etiquetas; `CONVERSATION_SELECT` incluye `line_id, area`.

- [ ] **Step 1-5:** prueba de que el filtro por línea reduce la lista y que la etiqueta se muestra; implementar; commit. (Las políticas RLS ya ocultan a cada persona lo que no es de su área.)

### Task 8: Plantillas y difusiones por línea
**Files:**
- Modify: `src/app/api/whatsapp/templates/{submit,sync}/route.ts`, `templates/[id]/route.ts`, `broadcast/route.ts:138`, `src/lib/whatsapp/broadcast-core.ts:116`, `broadcast-dispatch.ts:154,272-280`
- Test: pruebas existentes de esos archivos + una nueva

**Interfaces:**
- Produces: aceptan `line_id` opcional; sin él usan la línea principal; una plantilla solo se envía por una línea que comparta su `waba_id` (si no, error claro en español). Limitación documentada en la pantalla: las plantillas se gestionan por cuenta de WhatsApp de Meta.

- [ ] **Step 1-5:** prueba de rechazo con WABA distinto y de uso por defecto; implementar; commit.

### Task 9: Golden Habitat (puesta en marcha, sin código)
- [ ] Confirmar con Bryce que la línea actual de Golden es **Ventas**; SQL completo en el chat para ponerle `line_name = 'Ventas'`, `area = 'ventas'`, `is_primary = true`.
- [ ] Bryce compra/registra los números de Legal, Cobranzas y Posventa y los agrega desde "Agregar línea" (cuenta de Golden), eligiendo el portafolio de Golden; comprobar el tope de números de Meta antes (2 sin verificar, 20 verificado).
- [ ] SQL en el chat para dar `area` y `logo_url` a cada línea y asignar `profiles.area` a las personas de Golden (incluida `posventa`).
- [ ] Prueba real: mensaje de ida y vuelta por cada línea; una persona de legal no ve cobranzas; gerencia ve todo.

---

## FASE 2 - Traspaso entre áreas (mismo número)

### Task 10: Migración 104 y función de traspaso
**Files:**
- Create: `supabase/migrations/104_traspaso_area.sql`
- Test: `src/lib/whatsapp/traspaso-104.database.test.ts`

**Interfaces:**
- Produces: `transfer_conversation_area(p_conversation uuid, p_to_area text, p_note text DEFAULT NULL) RETURNS void` (SECURITY DEFINER): exige acceso a la conversación; cambia `conversations.area` a `p_to_area` (valores válidos de `profiles.area`, incluidos `administracion` y `gerencia`, aunque no tengan línea); `assigned_agent_id = pick_area_agent(account, p_to_area)` (060:19) o nulo; inserta una nota interna en `messages` que deja constancia (de quién a qué área); **no cambia `line_id`**.

- [ ] **Step 1:** pruebas: tras traspasar legal → posventa el usuario de legal ya no ve la conversación y el de posventa sí; `line_id` no cambia; gerencia siempre ve; una persona sin acceso no puede traspasar.
- [ ] **Step 2-5:** implementar y commit.

### Task 11: Botón "Pasar a otra área" en el hilo
**Files:**
- Modify: `src/components/inbox/message-thread.tsx:768-786,966-1024` (junto al menú "Assign")
- Test: prueba del componente

**Interfaces:**
- Consumes: `transfer_conversation_area` vía `supabase.rpc`.
- Produces: menú con las áreas (con nota opcional); la nota interna se ve en el hilo; la etiqueta de línea (número por el que habla el cliente) no cambia.

- [ ] **Step 1-5:** prueba de que el menú llama al RPC con el área y la nota; implementar; commit.

---

## FASE 3 - Una IA por línea

### Task 12: Migración 105 y configuración de IA por línea
**Files:**
- Create: `supabase/migrations/105_ia_por_linea.sql`; Modify: `src/lib/ai/config.ts:56-66`, `src/lib/ai/auto-reply.ts:47-101`, `src/app/api/whatsapp/webhook/route.ts:906-913` (pasar la línea)
- Test: `src/lib/ai/config.test.ts`, `src/lib/ai/auto-reply.test.ts`

**Interfaces:**
- Produces: `ai_configs.line_id uuid REFERENCES whatsapp_config(id)` (nulo = IA de la cuenta); se reemplaza `UNIQUE(account_id)` por dos índices únicos parciales (`(account_id) WHERE line_id IS NULL` y `(account_id, line_id) WHERE line_id IS NOT NULL`); `loadAiConfig(db, accountId, lineId?)`: usa la de la línea y si no existe la de la cuenta.

- [ ] **Step 1:** pruebas: conversación de la línea Legal usa el prompt de Legal; sin config propia usa la de la cuenta; la base de conocimiento queda ligada a la configuración elegida.
- [ ] **Step 2-5:** implementar; commit.

### Task 13: Pantalla de IA por línea
**Files:**
- Modify: la pantalla de configuración de IA (`src/components/settings/` - ubicar en la fase; no se mapeó): selector de línea y copia del prompt de la cuenta como punto de partida.
- [ ] Prueba del componente, implementar, commit. Fuera de alcance: IA que traspase sola entre áreas (se evalúa después de la fase 2 en uso real).

---

## Verificación end to end
- `npx vitest run` (proyectos `unit` y `database`) y `npx tsc --noEmit` sin errores nuevos; `npm run lint`.
- Local: cuenta con 2 líneas de prueba (números de prueba de Meta o dos filas simuladas); mensaje entrante simulado al webhook por cada `phone_number_id`; responder desde la bandeja y comprobar en el mock de Graph que sale por el número correcto.
- Producción, por fase (con SQL en el chat): Golden con sus líneas reales, usuarios de áreas distintas viendo solo lo suyo, gerencia viendo todo, traspaso legal → posventa sin cambiar de número, IA de cada línea respondiendo con su tono.
- Riesgos a vigilar: tope de números de Meta (2/20), plantillas de otra cuenta de WhatsApp, y que una cuenta con una línea no cambie.

## Fuera de alcance (YAGNI)
- Cambiar de número al traspasar, grupos de WhatsApp, y números con app en celular para las áreas (solo API).
