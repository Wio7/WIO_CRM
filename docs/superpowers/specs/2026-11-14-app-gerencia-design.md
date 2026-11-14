# Plan: App de Gerencia de Golden (F7)

## Contexto
Cada área de Golden Habitat ya tiene su app (Golden App/ventas, Legal, Cobranzas, Administración, Caja, Marketing). Gerencia — [[Leandro]] (gerente general), [[Eric]] (gerente comercial) y Kevin Leandro (dueño) — no tiene una vista que junte todo y hoy **ejecuta directo** (abonos a capital) sin pedidos ni registro. Bryce pidió la app de Gerencia con un plan completo basado en cómo lo hacen otros.

**Decisiones de Bryce (2026-11-14):**
1. Orden: **tablero primero, después la bandeja de aprobaciones**, al final lotes y firmas del catálogo.
2. Aprueba **cualquiera de gerencia** (Leandro, Eric o el dueño); el primero decide, queda registrado; nadie aprueba su propio pedido.
3. **Metas mensuales se cargan en la app** (cobranza y ventas por proyecto); sin meta, se compara con el mes anterior.
4. **Firmar contratos ("firmado por gerencia"), liberar y bloquear lotes pasa a ser solo de gerencia y dueño** (Sara y Manuel siguen aprobando separaciones).

## Lo que enseña la investigación (resumen)
- **Bandeja única de aprobaciones** (Odoo Approvals, OCA `base_tier_validation`, Frappe workflow, NetSuite, SAP My Inbox): cada pedido con tipo, cliente/lote, monto fijado, motivo, quién pide, antigüedad; aprobar o **rechazar con motivo obligatorio**; sin autoaprobación; el **efecto se ejecuta en la misma transacción** al aprobar; registro propio de auditoría; aviso al aprobador y al solicitante.
- **Portada por excepción** (Domo, FitGap, Basedash): 6–10 indicadores con umbral y responsable; mostrar primero lo que está en rojo; cada tarjeta lleva a la lista filtrada (drill-down, filtro en la URL).
- **Tarjeta KPI con delta vs mes anterior y color vs meta** (Frappe Number Card, Tremor).
- **Inmobiliario peruano** (Sperant): seguimiento de morosos por días de atraso con compromiso y si cumplió; inventario de lotes en tiempo real; metas por proyecto; reportes anclados en el inicio.
- KPIs y fórmulas: morosidad = vencido / cartera; tramos 1-30/31-60/61-90/90+; recaudación del mes = cobrado de lo que vencía / lo que vencía; cumplimiento = cobrado / meta; cartera en riesgo = (vencido +90 + reprogramado) / cartera; absorción = lotes vendidos en el mes / libres al inicio; costo por lead y por separación; tiempo de aprobación; % de mora condonada.

## Fase 0 — Arreglo previo (marketing)
`marketing-golden/src/app/layout.tsx:23` todavía cambia el manifiesto a `?cuenta=golden` con sesión (el mismo problema que impedía instalar Cobranzas). Dejarlo fijo como en `golden-cobranzas` (commit 2c70bde) y push a main.

## Fase 1 — Tablero (solo base wioCRM, sin tocar otras apps)

### Base: migración 097 (repo ERP `wacrm-instalar`, la corre Bryce)
Solo objetos nuevos, idempotente, con `097_casos.sql` + prueba PGlite (falla sin la 097, pasa con ella), igual que 096.
- `gerencia_my_access()` → `{ rol: 'gerencia'|null }`: dueño, super admin o área gerencia (reusa `is_owner_or_gerencia`, 084:272).
- `management_goals` (account_id, month, project_id nullable, kind `cobranza`|`ventas`, amount_cents / units, set_by, timestamps) + RLS solo gerencia; RPC `gerencia_set_goal`.
- `gerencia_cobranza(p_month, p_project)` → jsonb: cartera total, vigente, vencida; **tramos 1-30/31-60/61-90/90+** (monto y clientes); recaudación del mes (vencía vs cobrado); cumplimiento vs meta; mora estimada; cobrado por día del mes; top 20 morosos (cliente, proyecto, días, monto, último pago). Base: vistas `payment_plan_balances` (084:577) e `installment_balances` (084:548); misma lógica de tramos que `src/lib/collections.ts:96` (`buildDebtors`).
- `gerencia_resumen(p_month)` → jsonb para la portada: los KPIs con delta vs mes anterior y su meta, más las **alertas** (morosos que pasaron a +90, recaudación bajo meta, movimientos de banco `revisar`/`por_conciliar` viejos, pedidos entre áreas sin atender hace más de 3 días en `module_handoffs`, gasto de caja del mes sobre el mes anterior).
- Reusar tal cual: `cash_management_panel` (094:53, gerencia ve todas las cajas/negocios), `cash_area_snapshot` (095:21), `marketing_summary` / `marketing_leads` (096, gerencia ya es "jefe").

### App: repo `Wio7/GERENCIA-GOLDEN` (vacío hoy) + proyecto Vercel propio
- Copiar la base de `administracion-golden` (middleware, login, `golden-frame`/`golden-shell` — su `AreaApp` ya incluye "gerencia", instalar, Mi cuenta, demo). **Manifiesto fijo** "Golden Gerencia" (`lib/apps/nombres.ts` ya lo define). Ícono propio (vino y dorado). Diseño de celular y de laptop separados.
- Acceso: patrón de `marketing-golden/src/lib/marketing/acceso.ts` con `gerencia_my_access`; otra área ve "Esta app es de otra área".
- Pantallas:
  1. **Inicio** — primero las alertas en rojo; luego 6–8 tarjetas (cobrado del mes vs meta, morosidad %, cartera +90, caja del mes, leads y costo por lead, pedidos entre áreas pendientes). Cada tarjeta abre su sección filtrada.
  2. **Cobranza** — tramos, recaudación por día vs meta, morosos con búsqueda y filtro por proyecto/tramo; ficha de cliente de solo lectura.
  3. **Caja** — panel de gerencia de todas las cajas (La Jato, Cafetería, etc.) por proyecto y rubro (reusar `components/cash/panel-gerencia.tsx` de administración).
  4. **Marketing** — el resumen de marketing (componentes de `marketing-golden`).
  5. **Áreas** — un renglón por área: qué tiene pendiente y hace cuánto (traspasos, vouchers por revisar, piezas en revisión).
  6. **Metas** — cargar la meta del mes por proyecto.
- `src/lib/gerencia/*` con lógica pura y pruebas (deltas, semáforo, tramos, formato de soles).

## Fase 2 — Bandeja de aprobaciones (conexión #7 Cobranzas → Gerencia)
Diseño ya escrito en `docs/superpowers/specs/2026-11-09-areas-pendientes-design.md` §3.3; se respeta.
- Migración 098: `management_requests` (account_id, kind `abono_capital`|`condonacion`|`reprogramacion`, plan_id, cuotas, **monto fijado al pedir**, payload jsonb, motivo, status `pendiente`|`aprobada`|`rechazada`|`retirada`, requested_by, decided_by, decided_at, decision_note, resultado) + historial.
- RPCs: `request_management_approval` (cobranzas), `withdraw_management_request` (quien pidió), `decide_management_request(id, aprobar, nota)` — solo gerencia, **no el mismo que pidió**, rechazo exige nota, y al aprobar **ejecuta el efecto en la misma transacción**: abono → lógica de `apply_prepayment` (084:1493); condonación → cuotas/mora condonada (estado de 083:43, RPC nueva); reprogramación → RPC nueva (regla de Golden: una sola vez).
- Cobranzas (`golden-cobranzas`): botón **"Pedir a gerencia"** en la ficha del cliente y lista "Mis pedidos". Gerencia: pestaña **Aprobar** con contador en el inicio.
- Avisos: push a gerencia al llegar un pedido y al solicitante al decidirse; correo de registro con copia a administración (lo pidió Eric).
- KPI nuevo: tiempo de aprobación y % de mora condonada.

## Fase 3 — Lotes y firmas (base del catálogo de la Golden App)
- Migración del catálogo 0012 (`golden-3d-mas`): área `gerencia` en `gh_equipo`; `firmado_gerencia` en `gh_etapa_marcar` (0011:229) y `gh_lote_cambio_manual` (0011:338) para bloquear/habilitar/liberar **solo gerencia y dueño**; `gh_puede_resolver` sigue para separaciones.
- La app de Gerencia se conecta también a la base del catálogo (segundo cliente Supabase, como `crm.js` en la Golden App) con la cuenta de catálogo de cada gerente; se les pide entrar una vez. Pantallas: **Inventario** por proyecto (libre/solicitado/separado/vendido/bloqueado, absorción), **Contratos por firmar** (`gh_separaciones_panel`, 0011:449, etapa `firmado_cliente` cumplida), **Liberaciones** con motivo y titular anterior (`gh_titulares_lote`, `gh_historial_lote`).
- Pedido de liberación desde Cobranzas (conexión #8) entra a la misma bandeja de la fase 2.

## Archivos clave
- ERP: `wacrm-instalar/supabase/migrations/084_*` (vistas de saldos, `is_owner_or_gerencia`, `apply_prepayment`), `094_*`, `095_*`, `096_marketing.sql` (modelo de migración + casos + PGlite), `src/lib/collections.ts`.
- Plantilla: `CRM WIO/administracion-golden/src/*`, `marketing-golden/src/lib/marketing/acceso.ts`, `golden-cobranzas/src/app/manifest.webmanifest/route.ts`.
- Catálogo: `Wio/golden-3d-mas/supabase/migrations/0010_*`, `0011_*`.

## Forma de trabajo
superpowers (writing-plans por fase, TDD, verification) + revisión EGM de cada migración antes de entregar el SQL; el SQL se le pasa a Bryce como archivo listo para pegar en `Wio\CRM WIO\`. Publicación directa a `main`.

## Verificación
- Cada migración: prueba PGlite que falla sin ella y pasa con ella; casos SQL (gerencia ve, cobranzas no entra, nadie aprueba lo suyo, rechazo sin nota falla, el efecto se aplica una sola vez).
- App: `tsc`, `eslint`, `vitest`, `next build --webpack`, `next start` + curl del manifiesto fijo; demo revisada a 375 px y en laptop con el navegador.
- Producción: Chrome la marca instalable; con una cuenta de gerencia se ve todo; con una de cobranzas "Esta app es de otra área"; cifras del inicio cuadradas a mano contra Cobranzas y Caja de un mes real.
- Anotar en el vault: [[ERP de Golden Habitat]], diario y log.

## Pendiente de Bryce
- Correr cada SQL (097, 098, catálogo 0012) y conectar `GERENCIA-GOLDEN` a Vercel.
- Metas del primer mes (o se cargan desde la app).
- Cuentas del catálogo para Leandro y Kevin (fase 3).
