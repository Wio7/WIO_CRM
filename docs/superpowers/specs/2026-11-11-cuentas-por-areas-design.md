# Cuentas por áreas (2026-11-11)

Rama `aurex/cuentas-por-areas` (cortada de main 5fa5a09). Sin migraciones: todo con columnas que ya existen.

## Qué hace

1. **Super admin** (`/saas-owner`, protegido por `isSuperAdmin` como antes): cada negocio es una fila con
   botón **Entrar** (cambia de cuenta con `switchPlatformAccount` y abre `/dashboard`). Al desplegarlo se ve un
   árbol por áreas (Gerencia, Ventas, Legal, Cobranzas, Contabilidad, Marketing, Área técnica, Tienda si el
   módulo `/store` está encendido, Sin área) y, al final, "Otras cuentas del negocio" (las cuentas con
   `parent_account_id` = el negocio, con su botón Entrar y sus acciones de siempre).
2. **Dueño** (`/cuentas`, item "Cuentas" debajo de "Panel principal"): el mismo árbol, solo de su cuenta. Lo ven
   el rol `owner` y quienes tienen área `gerencia`; para el resto el item no sale, la página los manda al
   panel y el endpoint responde 403.

## Piezas

| Pieza | Archivo |
|---|---|
| Mapa área -> ruta ERP / app web / estado, y `puedeVerCuentas` (puro) | `src/lib/areas/destinos.ts` |
| Agrupación por área (puro): `armarArbol(miembros, cuenta, origen)` | `src/lib/areas/arbol.ts` |
| Componente compartido | `src/components/cuentas/account-area-tree.tsx` |
| Envoltorio del super admin (lee `/api/admin/accounts/[id]/members`) | `src/components/saas-owner/account-area-tree-admin.tsx` |
| Endpoint del dueño | `src/app/api/account/team-tree/route.ts` |
| Página del dueño | `src/app/(dashboard)/cuentas/page.tsx` |
| Destino tras cambiar de cuenta | `switchPlatformAccount(supabase, id, destino?)` |

## Decisiones

- **Estado de la persona**: `profiles` no tiene columna de estado/activo, así que todos salen "Activo". El estado
  que importa es el del área: "Apagada" si su ruta ERP está en `accounts.disabled_modules` (con dependencias,
  vía `isModuleDisabled`), si no "Activa". Un área apagada deshabilita su botón ERP.
- **Mapa de destinos**: gerencia y área técnica -> `/dashboard`; ventas -> `/contacts` (o `/pipelines` si
  contactos está apagado); legal y contabilidad -> `/payment-plans` (el ERP no tiene ruta `/legal`);
  cobranzas -> `/collections`; marketing -> `/broadcasts`.
- **Apps web**: Golden App (ventas) y Golden Legal solo en Golden (detectado por /golden/i en nombre o marca);
  Cobranzas (`/cobranzas`) y Caja (`/caja`) son rutas del propio repo y el link se arma con el origen actual;
  Tienda de Vita Life con una constante. Gerencia, marketing y técnica no tienen app: se muestra "App en camino"
  deshabilitado. Cuando una de esas entre en `EXISTENTES` de `src/lib/apps/acceso.ts`, el árbol la toma sola
  (`appDeArea`). `acceso.ts` y `nombres.ts` no se tocaron, solo se reusan; la Caja usa `cajaMenuLabel`.
- **Copiar link** (sirve también para instalar la app en el celular). **Sin QR**: `qrcode` no está en
  `package.json` y no se agregó dependencia.
- **Destino tras Entrar**: `switchPlatformAccount` acepta una ruta propia; solo vale si empieza con una sola `/`
  (nada de `//` ni `https://`), si no cae a `/dashboard`.
- **Endpoint del dueño**: usa `getCurrentAccount()` y el cliente con sesión (RLS de `profiles` ya limita a la
  misma cuenta) más un filtro explícito por `accountId`. Lee su propia área para decidir; si la columna `area`
  o `brand_name`/`disabled_modules` aún no existen, vuelve a pedir lo básico en vez de romper.
- **Diseño**: dos diseños separados, no uno estirado. `md` y más: fila por área con los botones a la derecha;
  celular: tarjeta apilada con los botones abajo, a todo el ancho.
- `/cuentas` se agregó a las rutas protegidas de `src/lib/app-paths.ts`.
- `AccountTeam` (lista plana de correos) quedó sin uso en la página; el archivo sigue ahí.

## Pruebas

`destinos.test.ts`, `arbol.test.ts`, `team-tree/route.test.ts` (403 agente sin gerencia, 200 dueño y gerencia,
401 sin sesión, solo su cuenta), `account-switch.test.ts` (destino), `app-paths.test.ts`.
