# Plan: "Conectar mi WhatsApp" (Embedded Signup + coexistencia)

Fecha: 2026-10-22. Estado: plan, sin codigo todavia.

## Objetivo
Que cualquier cuenta de Wio CRM conecte su numero de WhatsApp Business **sin dejar de usarlo en el celular** (coexistencia) con un boton, sin pegar tokens a mano. Primer cliente: el numero de Bryce (+51 940 421 629). Despues, todos los clientes de Wio CRM.

## Hechos verificados (2026-10-22)
- Coexistencia solo se ofrece via **Embedded Signup** y exige que la app sea **Tech Provider** o Solution Partner. Fuente: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- Embedded Signup v2/v3 quedaron deprecados el 2026-10-15: usar **v4** (o v5, donde la coexistencia viene activada por defecto). Fuente: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
- **Se puede probar antes de la revision**: admins/desarrolladores de la app WIO.CRM pueden correr el flujo con sus propias credenciales. Fuente: misma pagina.
- Tech Provider = verificacion del negocio -> icono, politica de privacidad, categoria -> 2 videos -> acceso avanzado a `whatsapp_business_messaging` y `whatsapp_business_management` -> App Review. Fuente: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers
- Hoy (via conector MCP de Meta): negocio WioCompany (3934948996738275), app WIO.CRM (1703821730766402) publicada, webhooks con 10 campos, numero Golden Habitat registrado. WioCompany **no verificado**, **sin metodo de pago**.

## Como esta hoy el CRM
- `whatsapp_config` (una fila por cuenta, `account_id`): `phone_number_id`, `waba_id`, `access_token` cifrado (AES-GCM, `src/lib/whatsapp/encryption.ts`). Se carga pegando el token a mano en `src/components/settings/whatsapp-config.tsx` -> `POST /api/whatsapp/config` (que ademas registra el numero con PIN).
- Webhook unico de la app: `src/app/api/whatsapp/webhook/route.ts`, enruta por `value.metadata.phone_number_id` -> `whatsapp_config`. Maneja `messages`, `statuses`, reacciones y eventos de plantillas. No conoce `history`, `smb_app_state_sync` ni `smb_message_echoes`.
- Ya hay un flujo OAuth de Meta para Leads/Messenger (`src/lib/meta-leads/oauth.ts`, migracion 037) con `META_APP_ID` / `META_APP_SECRET`: reutilizar su patron de cifrado y de manejo de errores.

## Parte A - Tramites en Meta (Bryce, salvo donde se indica)
1. [Bryce] Verificar WioCompany (Centro de seguridad). Bloquea el App Review.
2. [Bryce] Metodo de pago en la cuenta de WhatsApp de WioCompany.
3. [Bryce] WhatsApp Business del celular >= 2.24.17, con uso diario.
4. [Aurex] App Dashboard de WIO.CRM: icono, politica de privacidad (URL publica en el dominio de Wio CRM), categoria.
5. [Aurex] Facebook Login for Business -> Settings: activar Client/Web OAuth, Enforce HTTPS, Embedded Browser OAuth, Strict Mode, Login with JS SDK; agregar el dominio de produccion en Allowed domains y Valid OAuth redirect URIs.
6. [Aurex] Configurations -> crear desde plantilla "WhatsApp Embedded Signup Configuration With 60 Expiration Token" -> guardar `config_id` como env `META_ES_CONFIG_ID` en Vercel.
7. [Aurex + Bryce] Videos para App Review: (1) mensaje enviado desde Wio CRM y recibido en WhatsApp, (2) crear una plantilla desde Wio CRM. Ambos ya se pueden grabar hoy con el numero de Golden Habitat.
8. [Bryce] Pedir acceso avanzado a los dos permisos y "Begin App Review" (cuando 1 este aprobado). Elegir "Onboard without a partner".

## Parte B - Codigo en Wio CRM
Se desarrolla y prueba mientras Meta revisa; se prueba de verdad con la cuenta de Bryce (admin de la app) antes de la aprobacion.

### B1. Migracion `077_whatsapp_embedded_signup.sql`
- `whatsapp_config`: agregar `business_id TEXT`, `connection_type TEXT` (`manual` | `embedded` | `coexistence`), `is_on_biz_app BOOLEAN`, `history_sync_requested_at`, `contacts_sync_requested_at`, `history_sync_status TEXT`, `last_signup_error TEXT`.
- `access_token` pasa a guardar el **business token** del cliente (mismo cifrado).
- Idempotente, como las demas migraciones.

### B2. Boton y SDK (cliente)
- Componente `src/components/settings/whatsapp-embedded-signup.tsx` dentro de `whatsapp-config.tsx`: boton "Conectar mi WhatsApp". El modo manual queda como opcion avanzada.
- Carga `https://connect.facebook.net/en_US/sdk.js`, `FB.init({ appId, version })`, `FB.login(cb, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' } })` (confirmar los `extras` exactos de v4/v5 al implementar).
- Listener `message`: solo `origin` que termine en `facebook.com`, `type === 'WA_EMBEDDED_SIGNUP'`. Guardar `phone_number_id`, `waba_id`, `business_id` y el tipo de `event` (`FINISH`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `CANCEL` con `current_step` o error).
- El `code` vence en **30 s**: mandarlo al servidor junto con los datos del evento apenas llegue.

### B3. `POST /api/whatsapp/embedded-signup` (servidor)
1. Solo admins de la cuenta (mismo control que `/api/whatsapp/config`).
2. Canjear `code` por el business token (`GET /oauth/access_token` con app id/secret) - confirmar endpoint en la guia de Tech Providers.
3. Suscribir la app a la cuenta del cliente: `POST /{waba_id}/subscribed_apps`.
4. Si el evento es coexistencia: **no** registrar el numero (ya esta registrado). Si es numero nuevo: registrar como hoy.
5. Leer `is_on_biz_app` y `platform_type` del numero (esperado `true` / `CLOUD_API`).
6. Guardar en `whatsapp_config` (upsert por `account_id`), `status = 'connected'`.
7. Coexistencia: pedir **una sola vez** la sincronizacion de contactos y luego la de historial (SMB App Data API). Hay **24 h** para hacerlo.
8. Rechazar si ese `phone_number_id` ya esta en otra cuenta (el webhook enruta por ese id).

### B4. Webhook
- **Hecho (2026-10-23):** ecos salientes, historial por lotes y contactos con nombres protegidos; dedupe por cuenta/Meta id, timestamps originales y procesamiento silencioso dentro de `after()`. Migración local `079_whatsapp_coexistence_sync.sql` pendiente de aplicar; modo equipo Golden preservado. Pruebas de mapeo, webhook y PostgreSQL local incluidas. `account_update` queda fuera de este paso implementado.
- **Paso manual pendiente:** en Meta App Dashboard → WhatsApp > Configuration > Webhook fields, suscribir `history`, `smb_app_state_sync` y `smb_message_echoes`.
- Suscribir en el App Dashboard los campos `history`, `smb_app_state_sync`, `smb_message_echoes` (ademas de `account_update`, que ya esta).
- `smb_message_echoes`: lo que el cliente manda desde el celular -> guardarlo como mensaje saliente en la conversacion (sin reenviarlo).
- `history`: importar hasta 180 dias de chats 1:1 por lotes, sin disparar automatizaciones, IA ni avisos.
- `smb_app_state_sync`: crear o actualizar contactos.
- `account_update`: registrar altas, bajas (el cliente se desconecta desde su app) y cambios de estado.
- Deduplicar por id de mensaje de Meta (ya existe `lookupInternalIdByMetaId`).

### B5. Interfaz y avisos
- Antes de conectar, mostrar lo que cambia: se desvinculan WhatsApp Web/escritorio (WhatsApp para Windows no funciona), las listas de difusion quedan solo lectura, no pasan grupos, mensajes temporales ni "ver una vez", bienvenida/ausencia/respuestas rapidas pasan al CRM.
- Despues: estado de la sincronizacion de historial, calidad del numero y aviso de "dejar la app abierta mientras se copia".

### B6. Pruebas
- Unitarias: validacion del evento `message` (origen, tipos), canje del code (mock), parseo de `history`/`smb_message_echoes`/`smb_app_state_sync` con payloads reales de la documentacion, dedupe.
- Real: conectar el numero de Bryce con su cuenta de admin. Verificar: mensaje entrante en el CRM, mensaje mandado desde el celular aparece en el CRM, plantilla enviada desde el CRM llega, el celular sigue funcionando, WhatsApp Web se puede volver a vincular (Aurex Dictado lo usa).

## Riesgos y pendientes
- Peru en la lista de paises de coexistencia: confirmar en la documentacion oficial antes de prometerlo a clientes.
- Probar antes de la revision depende de que Meta permita Embedded Signup sin ser Tech Provider aprobado para admins de la app; si no, el paso real espera a la aprobacion.
- Clientes pagan sus mensajes a Meta con su tarjeta (modelo Tech Provider). Desde 2026-10-01 las plantillas de utilidad dentro de la ventana de 24 h se cobran.
- Entrega: segun la regla de Bryce, todo va directo a `main` (produccion) despues de probar en local. Hoy el checkout esta en `feat/whatsapp-modo-caja`: partir de `main` actualizado.

## Orden de trabajo
1. B1 + B3 + B2 (conexion) -> probar con la cuenta de Bryce.
2. B4 (eco, historial, contactos) -> el CRM queda igual que el celular.
3. B5 (avisos y estado).
4. Parte A 7-8 en cuanto WioCompany este verificada.
