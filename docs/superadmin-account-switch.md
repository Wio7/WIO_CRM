# Selector de cuentas del superadmin

Implementado según `superpowers/specs/2026-10-20-superadmin-account-switch-design.md`, revisión 2.

## Archivos de esta implementación

Creado:

- `supabase/migrations/067_platform_admins.sql`: registro privado, auditoría, siembra, RLS y RPC transaccionales de entrada/salida.
- `src/lib/auth/account-switch.ts`: RPC, aviso a otras pestañas y recarga completa.
- `src/components/platform-admin-banner.tsx`: aviso global con cuenta y Salir, también en Caja.
- Pruebas: `src/lib/auth/account-switch.test.ts`, `src/lib/auth/admin-routes.test.ts`, `src/lib/auth/platform-admins.database.test.ts`, `src/components/platform-admin-banner.test.tsx`.
- Este reporte.

Modificado:

- `src/hooks/use-auth.tsx`: permisos desde `platform_admins`, `isVisiting`, `homeAccountId`.
- `src/lib/auth/account.ts` y `account.test.ts`: `requireSuperAdmin()` y sus pruebas; `getCurrentAccount()` conserva su implementación.
- `src/app/api/admin/accounts/create/route.ts`, `delete/route.ts`, `[accountId]/invitations/route.ts`: guard compartido.
- `src/app/(auth)/login/page.tsx`: aterrizaje del superadmin en agencia o cuenta visitada; conserva invitaciones y acceso a Caja para usuarios normales.
- `src/app/(dashboard)/saas-owner/page.tsx`: Entrar/Dentro y estados de espera/error.
- `src/app/layout.tsx`, `src/app/(dashboard)/dashboard-shell.tsx`: un único proveedor de autenticación y aviso por encima de ambos módulos.
- `src/app/globals.css`, `src/components/layout/sidebar.tsx`: espacio para la barra sin tapar las navegaciones fijas.
- `.env.local`: retirada únicamente la variable pública de correo de superadmin, sin mostrar ni cambiar las demás variables.

Se conservaron los cambios que ya existían en el árbol de trabajo. No se añadieron dependencias ni se hizo commit/despliegue.

## Decisiones de implementación

- Se usa el único superadmin y el correo de siembra aprobados en el diseño. No se creó ni editó ningún usuario real.
- Entrar y salir bloquean la fila del superadmin durante la transacción para serializar cambios simultáneos. Si falta el perfil, falla la operación completa.
- El identificador de cuenta de la auditoría se conserva sin FK para no perder el dato histórico al eliminar una cuenta.
- Se protege la cuenta de origen mediante FK y se bloquea eliminar la cuenta visitada. La ruta de borrado lo comprueba antes de eliminar usuarios; utiliza `profiles.user_id` como identidad Auth.
- La política anterior de actualización de perfiles permitía editar directamente `account_id` y `account_role`. Un trigger impide esos cambios desde `authenticated`/`anon`; las RPC existentes con `SECURITY DEFINER` y la edición normal de nombre/avatar siguen funcionando. Esto evita una vía alternativa de cambio de cuenta para usuarios normales.
- Las pestañas locales reciben aviso de cambio y recargan; al recuperar el foco se compara el perfil con la cuenta mostrada para detectar cambios desde otro dispositivo. Se mantiene el modelo por usuario, no por sesión. No se garantiza sincronización instantánea de un dispositivo que permanezca activo sin recuperar el foco.
- La entrada a la propia cuenta desde la lista sigue la misma RPC y registra visita; Salir restaura el rol original guardado.

## Verificaciones del 2026-10-20

- `npm run typecheck`: aprobado.
- Suite completa, `$env:TZ='UTC'; npm test -- --maxWorkers=1`: **75 archivos, 728 pruebas aprobadas**.
- En la ejecución inicial con la zona horaria local fallaron dos pruebas existentes de `src/lib/dashboard/date-utils.test.ts` (`mondayIndex` usa fecha local y los fixtures parten de fechas UTC). No se modificó ese código; la suite completa pasa en UTC.
- ESLint de todos los TS/TSX tocados: **0 errores, 2 avisos existentes de `<img>`** en login/sidebar.
- `npm run lint`: **1 error y 28 avisos** globales. El error restante está en `src/app/api/public/leads/route.ts:190`, `no-explicit-any`, fuera del cambio.
- `git diff --check`: aprobado.
- Sin referencias al correo público ni al fallback de superadmin en `src`.

Las pruebas SQL ejecutan el archivo 067 real sobre PostgreSQL desechable en memoria (PGlite), junto con las funciones/políticas relevantes anteriores y las migraciones de Caja 063–065. Cubren rechazo de usuarios normales, RLS, aislamiento de asesores de 039, ida/vuelta con restauración del rol, cambio entre clientes, cuentas inactivas, idempotencia, siembra ausente, auditoría, rollback ante un fallo de auditoría, protección de borrado, gestión de roles y registro de Caja en la cuenta correcta. No equivalen a una validación de todo el esquema de producción.

Las pruebas de UI comprueban el render del aviso y las recargas tras RPC; no se realizó una comprobación visual autenticada en navegador con cuentas reales. Tampoco se verificaron en vivo WhatsApp, almacenamiento ni el despliegue. No se aplicó SQL a ninguna base de datos real.

## Activación pendiente, según el diseño

1. Editar el correo del usuario Auth existente a `brycebueno15@gmail.com`, conservando su `user_id` y fijando su contraseña desde Supabase.
2. Aplicar manualmente `067_platform_admins.sql` después de las migraciones anteriores.
3. Comprobar desde SQL que `platform_admins` contiene la fila correcta y su cuenta de origen. Si se aplicó antes de editar el correo, volver a ejecutar la migración: la siembra es idempotente.
4. Retirar también la variable pública obsoleta del entorno de despliegue, si existe, y desplegar el código.
5. Verificar login → agencia → Entrar → dashboard/Caja/equipo/archivos/WhatsApp → Salir. Confirmar que se restaura la cuenta de origen y que se cierra el tramo de auditoría.

Recuperación manual en una única transacción, si fuese necesaria:

```sql
BEGIN;
UPDATE public.profiles p
SET account_id = a.home_account_id, account_role = a.home_account_role
FROM public.platform_admins a
WHERE p.user_id = a.user_id;
UPDATE public.platform_admins
SET visiting_account_id = NULL, updated_at = now();
UPDATE public.platform_admin_audit
SET exited_at = now()
WHERE exited_at IS NULL;
COMMIT;
```
