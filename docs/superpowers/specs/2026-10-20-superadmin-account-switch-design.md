# Selector de cuentas para el dueño de la agencia (superadmin)

Diseño — 2026-10-20 · revisión 2

> La revisión 1 proponía un concepto nuevo de "cuenta activa" paralelo al que ya
> usa el CRM. Una revisión independiente del código demostró que eso dejaba roto
> todo lo que no pasa por las políticas de seguridad: caja, gestión de equipo,
> asignación automática, subida de archivos y la configuración de WhatsApp.
> Esta revisión cambia el enfoque y, de paso, queda más pequeña y más segura.

## 1. Intención y por qué

Bryce es el dueño de la agencia que opera Wio CRM. Hoy, cuando entra con sus
credenciales, aterriza en el dashboard de **su propia** cuenta y no tiene manera
de trabajar dentro de las cuentas de sus clientes (Golden, la nueva de Luis/Julio,
etc.). Para atender a un cliente tiene que pedir credenciales prestadas o tocar
la base de datos a mano.

Lo que quiere: entrar una sola vez con su correo, ver la lista de todas las
cuentas conectadas al CRM, pulsar **Entrar** al lado de una, y quedar dentro de
esa cuenta con las mismas capacidades que su dueño real — inbox, contactos,
pipelines, caja, reservas, ajustes, todo.

### Hallazgo 1 — el permiso ya existe, y está demasiado abierto

`is_account_member(account_id, min_role)` gobierna las 231 políticas de
seguridad (RLS) del CRM. Termina así (`041_clients_and_ai_handoff.sql`:81):

```sql
  ) OR COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com';
```

Es un bypass **global y permanente**: ese correo es `owner` de todas las cuentas
a la vez, siempre, sin forma de apagarlo. El mismo literal está incrustado en 15
políticas más de `031_saas_features.sql`. Y el correo también vive en
`NEXT_PUBLIC_SUPER_ADMIN_EMAIL`, que al llevar el prefijo `NEXT_PUBLIC_` **se
publica al navegador de cualquier visitante**.

### Hallazgo 2 — "en qué cuenta estoy" se resuelve en un solo sitio, y no es RLS

Ésta es la que define el diseño. `profiles.account_id` no es solo lo que leen
`getCurrentAccount()` y `useAuth()`: es lo que lee **todo** el código que decide
en qué cuenta está actuando. En particular, unas diez funciones `SECURITY
DEFINER` lo consultan directamente y **nunca** llaman a `is_account_member`:

| archivo | funciones |
|---|---|
| `063_golden_caja.sql` | `cash_role()`, `cash_snapshot()` |
| `065_cash_companies.sql` | `cash_company_list()`, `cash_company_snapshot()`, `cash_company_command()` |
| `064_cash_private_boxes_audit.sql` | líneas 43, 99 |
| `057_jerarquia_equipo.sql` | `set_member_role()`, `set_member_area()`, `remove_account_member()` |
| `046_member_areas.sql`, `039_advisor_ownership.sql`, `027_notifications.sql` | áreas, `save_push_subscription`, notificaciones |

Ejemplo concreto: `cash_role(p_account)` hace
`WHERE p.user_id = auth.uid() AND p.account_id = p_account`. Si la cuenta
seleccionada no es la del perfil, devuelve `NULL` y la caja queda muda.

Y en la capa de aplicación hay tres sitios más que resuelven la cuenta por su
cuenta: `src/app/api/whatsapp/config/route.ts` (con su propio `resolveAccountId`
y **cliente de servicio**, donde RLS no protege nada),
`src/app/(dashboard)/inbox/page.tsx:199` y
`src/lib/storage/upload-media.ts:96`, cuyas rutas `account-<id>/…` se validan
contra el perfil del que sube (`020_account_sharing_followups.sql`:71–110).

**Conclusión:** cualquier diseño que invente una "cuenta activa" aparte deja
todo eso apuntando a la cuenta de la agencia mientras la pantalla dice «Golden».
Eso es exactamente el anti-objetivo de §4. La única forma de que el CRM completo
siga a Bryce a la cuenta del cliente es **mover `profiles.account_id`**, que es
la fuente de verdad que todos ya consultan.

## 2. Objetivos

- Bryce entra con un solo correo y ve la lista de todas las cuentas.
- Cada fila tiene un botón **Entrar** que lo mete en esa cuenta como `owner`.
- Dentro, **todo el CRM funciona**, incluidos caja, equipo, asignación
  automática, archivos y WhatsApp — sin modificar ninguna consulta ni ruta.
- Una señal siempre visible de en qué cuenta está, con un botón **Salir**.
- El correo del superadmin se configura **en un solo lugar**, sin desplegar
  código y sin exponerlo al navegador.
- El bypass global desaparece: el acceso del superadmin pasa a ser pertenencia
  real a la cuenta donde está, y a ninguna otra.
- Volver a su propia cuenta es siempre posible, incluso si algo falla a medias.

## 3. No-objetivos

- **No** se implementa multi-pertenencia para usuarios normales. El CRM está
  construido sobre *un usuario = una cuenta* (`017_account_sharing.sql`, "the
  locked design decision"); `profiles` tiene `UNIQUE(user_id)`. Se respeta.
- **No** se da a dueños ni admins la capacidad de cambiar de cuenta.
- **No** se rediseña el panel `/saas-owner`. Se le añade una acción por fila.
- **No** se toca el portal de clientes por código (`client_portal_sessions`, que
  por cierto no se referencia desde `src/`). `/caja` sí queda cubierto, pero
  gratis, por el mecanismo de §6.

## 4. Anti-objetivos (fracaso aunque funcione)

- Que quede **un segundo camino** para resolver la cuenta, en paralelo al de
  `profiles.account_id`. Es el error que cometió la revisión 1.
- Que Bryce **escriba en la cuenta equivocada** creyendo estar en la suya: cobros
  en la caja del cliente anotados en la de la agencia, un número de WhatsApp de
  un cliente conectado a la cuenta de la agencia, archivos en la carpeta
  equivocada.
- Que al terminar siga teniendo acceso simultáneo a todas las cuentas.
- Que un cambio de correo mal aplicado **deje a Bryce fuera** sin forma de volver.
- Que entrar a una cuenta **le haga perder su propia cuenta** de forma
  irrecuperable.

## 5. Restricciones

- Next.js 16.2.6 (App Router) + Supabase. El `AGENTS.md` del repo advierte que
  esta versión trae cambios incompatibles con lo que los modelos tienen
  memorizado y **obliga a leer `node_modules/next/dist/docs/`** antes de escribir
  código que toque rutas, layouts o `next/headers`.
- Las migraciones son SQL numerado en `supabase/migrations/`, idempotentes,
  aplicadas a mano por Bryce desde el panel de Supabase. **La siguiente libre es
  la 067.**
- La seguridad real vive en RLS, porque el navegador consulta Supabase directo.
- `profiles.UNIQUE(user_id)`: un usuario tiene exactamente una fila de perfil.
  No se puede tener un perfil "sombra" en la cuenta destino.
- `handle_new_user()` (`017`:659–690) se dispara con cualquier `INSERT` en
  `auth.users`: crear un usuario nuevo desde el panel de Supabase **le crea
  automáticamente una cuenta propia vacía**, que aparecería como fila basura en
  `/saas-owner`. Ver §9.
- No hay contraseñas en ningún archivo de este repositorio.

## 6. La forma de la solución

La idea en una frase: **el superadmin no simula pertenecer a la cuenta; pertenece
de verdad, de una en una, y recuerda cuál es su casa.**

### 6.1 Migración `067_platform_admins.sql`

**Tabla `platform_admins`**:

| columna | tipo | nota |
|---|---|---|
| `user_id` | UUID PK → `auth.users(id)` ON DELETE CASCADE | el superadmin |
| `home_account_id` | UUID NOT NULL → `accounts(id)` | **su cuenta propia**, la de siempre. Nunca cambia |
| `home_account_role` | `account_role_enum` NOT NULL DEFAULT `'owner'` | su rol en casa, para restaurarlo al salir |
| `visiting_account_id` | UUID NULL → `accounts(id)` ON DELETE SET NULL | cuenta que está visitando; `NULL` = está en casa |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

`home_account_id` es el seguro de vida: mientras exista esa fila, volver a casa
es un `UPDATE` de una línea, sin depender de nada más.

RLS: cada quien lee **solo su propia fila**; nadie escribe por RLS (solo las
funciones de §6.2). Así el navegador puede preguntar "¿soy superadmin?" sin que
el dato sea público, y se retira `NEXT_PUBLIC_SUPER_ADMIN_EMAIL`.

**Tabla `platform_admin_audit`**: `id`, `user_id`, `account_id`, `entered_at`,
`exited_at NULL`. Solo la lee el propio superadmin.

> *Decisión mía, no acordada:* incluyo la auditoría. Bryce no respondió si quiere
> ser distinguible del dueño real; registrar es estrictamente más seguro, es
> invisible para el cliente, y si luego quiere mostrarlo el dato ya está.

**Siembra**, por correo (`brycebueno15@gmail.com`, ver §10.1), tolerante a que
el usuario no exista todavía:

```sql
INSERT INTO public.platform_admins (user_id, home_account_id, home_account_role)
SELECT p.user_id, p.account_id, p.account_role
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.user_id
 WHERE lower(u.email) = lower('<CORREO DEL SUPERADMIN>')
ON CONFLICT (user_id) DO NOTHING;
```

Para cambiar de superadmin en el futuro: esa misma sentencia. **La contraseña no
aparece aquí** — el usuario se crea o edita en Supabase → Authentication → Users.

**`is_super_admin()` redefinida**, sin literales de correo:

```sql
SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid());
```

**`is_account_member()` redefinida**: el cuerpo de `041` **tal cual**, pero
borrando el bypass del correo. Ya no hace falta: cuando Bryce visita Golden su
perfil *está* en Golden con rol `owner`, así que la rama normal lo aprueba. Solo
se conserva el literal convertido a función en la condición de estado, para que
pueda entrar a cuentas desactivadas:

```sql
  AND (a.status = 'active' OR public.is_super_admin())
  -- …resto idéntico a 041…
  );          -- ← sin el "OR COALESCE(auth.jwt() ->> 'email', …)"
```

**Políticas con el correo incrustado.** Esto es delicado y la revisión 1 lo tenía
mal. Lo verificado en el código:

- `accounts_select` / `accounts_update` / `accounts_delete` (de `031`) **siguen
  vivas** → recrearlas cambiando el literal por `public.is_super_admin()`, **sin
  acotar a una cuenta**: necesita ver y administrar la lista completa esté donde
  esté.
- `contacts_select` / `contacts_update` / `contacts_delete` (de `031`) **siguen
  vivas** → recrearlas **quitando la rama del correo entera**. La pertenencia
  real ya le da acceso como `admin`+, así que la rama es redundante, y quitarla
  elimina el acceso cruzado.
- `conversations_select` / `conversations_update` / `conversations_delete`
  **NO se tocan**. Fueron reemplazadas después, en `039_advisor_ownership.sql`:86–96,
  por versiones basadas en `can_access_conversation(...)` que ya no contienen
  ningún literal. **Copiar las de `031` revertiría el aislamiento de asesores de
  la 039 en todas las cuentas** — una fuga de privacidad silenciosa. El builder
  debe dejarlas exactamente como están.

### 6.2 Entrar y salir — funciones RPC

Dos funciones `SECURITY DEFINER`, que rechazan a quien no esté en
`platform_admins`. Cada una hace su trabajo en **una sola transacción**, de modo
que no existe un estado a medias:

**`platform_admin_enter_account(p_account_id UUID)`**
1. Verifica `is_super_admin()` y que la cuenta exista.
2. `UPDATE profiles SET account_id = p_account_id, account_role = 'owner' WHERE user_id = auth.uid()`.
3. `UPDATE platform_admins SET visiting_account_id = p_account_id`.
4. Cierra el tramo de auditoría abierto, si hay, y abre uno nuevo.

**`platform_admin_exit_account()`**
1. Verifica `is_super_admin()`.
2. `UPDATE profiles SET account_id = home_account_id, account_role = home_account_role`.
3. `UPDATE platform_admins SET visiting_account_id = NULL`.
4. Cierra el tramo de auditoría.

Entrar estando ya dentro de otra cuenta funciona sin pasar por casa: el paso 2
sobrescribe, y `home_account_id` nunca se toca.

Se llaman desde el navegador con `supabase.rpc(...)`; no hacen falta rutas de API.

### 6.3 Capa de aplicación

Lo notable es **cuán poco hay que cambiar**, que es la prueba de que el enfoque
es el correcto. `getCurrentAccount()`, `useAuth()`, las ~10 funciones de caja y
equipo, la ruta de WhatsApp, las rutas de almacenamiento y el `inbox` siguen
leyendo `profiles.account_id` y aciertan solos.

Lo que sí cambia:

- **`src/hooks/use-auth.tsx`**: `isSuperAdmin` deja de comparar contra
  `process.env.NEXT_PUBLIC_SUPER_ADMIN_EMAIL` y pasa a ser "mi fila de
  `platform_admins` existe". Se añaden al contexto `isVisiting: boolean` y
  `homeAccountId`.
- **`src/lib/auth/account.ts`**: nuevo guard compartido `requireSuperAdmin()`
  que consulta `platform_admins`. `getCurrentAccount()` **no cambia**.
- **Rutas `/api/admin/accounts/*`** (`create`, `delete`,
  `[accountId]/invitations`): las tres comparan `user.email` contra la variable
  de entorno; pasan a usar `requireSuperAdmin()`.
- **`NEXT_PUBLIC_SUPER_ADMIN_EMAIL`** se elimina del código y de `.env.local`,
  junto con los cuatro `|| "admin@wiocrm.com"` repartidos por el repo.

### 6.4 Interfaz

**`src/app/(dashboard)/saas-owner/page.tsx`** — un botón **Entrar** (icono
`LogIn`) como primera acción de cada fila, que llama al RPC. La fila de la cuenta
que está visitando se marca como «Dentro».

**Recarga completa, no navegación suave.** Tras el RPC, `window.location.assign("/dashboard")`,
no `router.push`. En cuanto el RPC confirma, las consultas directas a Supabase de
**cualquier** pestaña abierta se reautorizan contra la cuenta nueva, mientras el
estado de React de esa pestaña sigue con los identificadores de la anterior. Una
navegación suave conserva ese estado y es justo el camino al anti-objetivo de
escribir en la cuenta equivocada. Lo mismo al salir, hacia `/saas-owner`.

**Barra de aviso.** Cuando `isVisiting`, una barra fija e inconfundible:
`Estás dentro de «Golden» como superadmin` + botón **Salir**. Va **por encima
del grupo `(dashboard)`**, no dentro de `dashboard-shell.tsx`, porque `/caja`
vive fuera de ese grupo (`src/app/caja/`) y también necesita el aviso: ahí se
mueve dinero.

**Aterrizaje tras el login.** `src/app/(auth)/login/page.tsx` manda hoy a
`/dashboard`. Para un superadmin con `visiting_account_id = NULL`, a
`/saas-owner`; si está visitando, a `/dashboard`. Eso da la "vista de agencia"
que Bryce describió como lo primero que ve.

## 7. Lo que acepta este diseño, dicho claro

Mientras Bryce visita Golden:

1. **Su cuenta propia queda desatendida.** No recibe ni procesa nada en su
   nombre mientras está fuera. Para una persona sola que atiende clientes de uno
   en uno, es el comportamiento esperado.
2. **Es un miembro visible del equipo de Golden.** Su perfil está en esa cuenta,
   así que aparece en el listado de equipo, en los desplegables de asignación y
   en los miembros de caja — y el dueño real de Golden lo ve. A cambio, caja,
   roles y asignación automática funcionan de verdad. **Ésta es la decisión
   pendiente de Bryce** (ver §10).
3. **Es por usuario, no por sesión.** Si entra a Golden en el portátil y luego a
   otra cuenta en el móvil, el portátil cambia también. Más simple y acorde a
   cómo trabaja una persona sola. Si algún día necesita dos cuentas abiertas a la
   vez, hay que mover `visiting_account_id` a una tabla por sesión.
4. **Las filas que cree quedan a su nombre** (`user_id = auth.uid()`), dentro de
   la cuenta del cliente. Correcto y auditable, pero el dueño real verá su
   nombre en esos registros.

Los puntos 2 y 4 están aceptados explícitamente por Bryce (§10.2).

## 8. Decisiones que tomé yo

El builder y Bryce deben saber que estas fueron mías, no acordadas:

1. **Mover `profiles.account_id`** en lugar de inventar una cuenta activa
   paralela, con `home_account_id` como seguro de vuelta.
2. **Eliminar el bypass global** en vez de acotarlo, y quitar la rama del correo
   de `contacts_*` por redundante.
3. **No tocar las políticas de `conversations`** (evita revertir la 039).
4. **Recarga completa** al entrar y al salir.
5. **La barra de aviso por encima de `(dashboard)`**, para que cubra `/caja`.
6. **Incluir auditoría.**
7. **El cambio de correo del superadmin se hace con SQL**, no con una pantalla.

## 9. Orden de aplicación

Nada que tocar en Authentication: los dos usuarios ya existen (§10.1).

1. En el SQL Editor, mover el perfil del superadmin a Aurex con el `UPDATE`
   de §10.1.
2. Aplicar `067_platform_admins.sql` en el SQL Editor.
3. Verificar que la casa quedó en Aurex:
   ```sql
   SELECT pa.user_id, a.name AS casa, pa.visiting_account_id
     FROM platform_admins pa JOIN accounts a ON a.id = pa.home_account_id;
   ```
   Debe devolver una fila, con `casa = 'Aurex'` y `visiting_account_id` nulo.
4. Desplegar el código.
5. Entrar con `brycebueno15@gmail.com` → aterriza en `/saas-owner` → **Entrar**
   en Golden Habitat → ver los datos de Golden.

Aparte, pendiente y sin relación con esto: hay cuatro cuentas vacías creadas por
`handle_new_user()` cuando el personal de Golden se registró
(`paulauribegoldenhabitat@`, `legal.goldenhabitat@`, `arealegaldreamhabitat@`,
`asistentelegalgh@`). Esos usuarios son agentes legítimos **dentro** de Golden
Habitat; lo que sobra son sus cuentas propias, que ensucian el panel.

**Punto de retorno**, si algo sale mal a medias:

```sql
UPDATE public.profiles p
   SET account_id = a.home_account_id, account_role = a.home_account_role
  FROM public.platform_admins a
 WHERE p.user_id = a.user_id;
UPDATE public.platform_admins SET visiting_account_id = NULL;
```

## 10. Decisiones de Bryce (cerradas el 2026-10-20)

1. **El superadmin es `brycebueno15@gmail.com`, con la casa en Aurex.**

   > Corregido tras inspeccionar la base real: **los dos usuarios ya existían**,
   > cada uno dueño de una cuenta distinta — `wiocompany7@gmail.com` de **Aurex**
   > (la agencia, 1 miembro) y `brycebueno15@gmail.com` de **Golden Habitat**
   > (10 miembros, la cuenta que se usa). No se puede renombrar el correo del
   > primero porque el segundo ya lo ocupa.

   Por eso, **antes** de aplicar la 067 se mueve el perfil del superadmin a
   Aurex, para que su casa sea la agencia y no una cuenta de cliente:

   ```sql
   UPDATE public.profiles
      SET account_id = '225298bc-5082-437c-a00f-f254e2141ed9',  -- Aurex
          account_role = 'owner'
    WHERE user_id = 'c5cbf137-b635-43c4-bee4-953016c342d1';     -- brycebueno15@gmail.com
   ```

   Es seguro: Golden Habitat conserva a `escalante_2010@hotmail.com` como dueño
   residente. `accounts.owner_user_id` de Golden sigue apuntando a
   `brycebueno15`, lo cual no afecta a los permisos (que se resuelven por
   `profiles.account_role`) ni al índice único de una cuenta por dueño.

   `wiocompany7@gmail.com` **deja de ser superadmin** al aplicarse la 067: el
   bypass global desaparece y el acceso sale solo de `platform_admins`. No se
   crea ningún usuario, así que no aparece la cuenta vacía de
   `handle_new_user()`.
2. **Visible como miembro del equipo** del cliente (§7.2). Aparece en el listado
   de equipo, en los desplegables de asignación y en los miembros de caja; el
   dueño real lo ve. A cambio, caja, roles y asignación automática funcionan de
   verdad. No hay que ocultarlo de ninguna consulta.

## 11. Lo que queda a criterio del builder

- Textos, iconos y clases de la barra de aviso y del botón Entrar, siguiendo el
  estilo de `saas-owner/page.tsx` y `dashboard-shell.tsx`.
- Si el estado «Dentro» de la fila se resuelve en el cliente o se lee del RPC.
- Qué pruebas añadir. El repo usa Vitest y ya tiene `src/lib/auth/roles.test.ts`
  y `account.test.ts`; lo mínimo razonable son casos para `requireSuperAdmin()` y
  para el ir-y-volver de las dos RPC.
