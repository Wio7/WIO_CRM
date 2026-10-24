export interface SaasAccount {
  id: string;
  name: string;
  status: string;
  created_at: string;
  default_currency: string;
}

export interface BusinessGroup {
  key: string;
  /** Negocio al que pertenece (Golden Habitat, Broker Home, Juris Pro…). */
  name: string;
  /** Familia de aplicaciones que el negocio tiene dentro de Wio. */
  apps: string[];
  /** Cuenta real del negocio: la que lleva datos, contactos y equipo. */
  primary: SaasAccount;
  /** Cuentas de acceso sueltas de su personal (correos que se registraron solos). */
  members: SaasAccount[];
}

interface BusinessRule {
  key: string;
  name: string;
  apps: string[];
  /** Reconoce por nombre de cuenta (o correo) a qué negocio pertenece. */
  test: RegExp;
}

// El orden de la lista es el orden en pantalla. Las cuentas se reconocen por
// nombre porque la tabla `accounts` no guarda de qué negocio cuelga cada correo.
const BUSINESS_RULES: BusinessRule[] = [
  {
    key: "golden-habitat",
    name: "Golden Habitat",
    apps: ["Golden App (ventas)", "Golden Caja", "Golden Legal"],
    test: /golden|dreamhabitat|legalgh/i,
  },
  { key: "broker-home", name: "Broker Home", apps: [], test: /julio\s+palli|broker\s*home/i },
  { key: "juris-pro", name: "Juris Pro", apps: [], test: /christian\s+linares|juris\s*pro/i },
  { key: "aurex", name: "Aurex", apps: [], test: /aurex/i },
];

const isEmailName = (name: string) => name.includes("@");

/**
 * Agrupa las cuentas por negocio. Dentro de un negocio, la cuenta real es la
 * que lleva nombre de empresa; las que tienen un correo como nombre son
 * accesos de su personal y quedan anidadas debajo.
 */
export function groupAccountsByBusiness(accounts: SaasAccount[]): BusinessGroup[] {
  const buckets = new Map<string, { rule: BusinessRule | null; accounts: SaasAccount[] }>();

  for (const rule of BUSINESS_RULES) buckets.set(rule.key, { rule, accounts: [] });

  const unmatched: SaasAccount[] = [];
  for (const account of accounts) {
    const rule = BUSINESS_RULES.find((r) => r.test.test(account.name));
    if (rule) buckets.get(rule.key)!.accounts.push(account);
    else unmatched.push(account);
  }

  const groups: BusinessGroup[] = [];

  for (const { rule, accounts: list } of buckets.values()) {
    if (!rule || list.length === 0) continue;
    const primary = list.find((a) => !isEmailName(a.name)) ?? list[0];
    groups.push({
      key: rule.key,
      name: rule.name,
      apps: rule.apps,
      primary,
      members: list.filter((a) => a.id !== primary.id),
    });
  }

  // Cuenta no reconocida: es un negocio propio, con su nombre.
  for (const account of unmatched) {
    groups.push({ key: account.id, name: account.name, apps: [], primary: account, members: [] });
  }

  return groups;
}
