export interface SaasAccount {
  id: string;
  name: string;
  status: string;
  created_at: string;
  default_currency: string;
  /** Módulos apagados de la cuenta (migración 066); lo usa el árbol por áreas. */
  disabled_modules?: string[] | null;
  /** Negocio del que cuelga (migración 081). null = es un negocio. undefined = la base aún no tiene la columna. */
  parent_account_id?: string | null;
  /** Apps del negocio, o las que usa la cuenta que cuelga (migración 081). */
  apps?: string[] | null;
}

export interface BusinessGroup {
  key: string;
  /** Negocio al que pertenece (Golden Habitat, Broker Home, Juris Pro…). */
  name: string;
  /** Familia de aplicaciones que el negocio tiene dentro de Wio. */
  apps: string[];
  /** Cuenta real del negocio: la que lleva datos, contactos y equipo. */
  primary: SaasAccount;
  /** Cuentas que cuelgan del negocio (correos de su personal que se registraron solos). */
  members: SaasAccount[];
}

interface BusinessRule {
  key: string;
  name: string;
  apps: string[];
  /** Reconoce por nombre de cuenta (o correo) a qué negocio pertenece. */
  test: RegExp;
}

// Orden en pantalla y respaldo mientras la base no tenga la migración 081:
// antes de eso las cuentas solo se pueden reconocer por su nombre.
const BUSINESS_RULES: BusinessRule[] = [
  {
    key: "golden-habitat",
    name: "Golden Habitat",
    apps: ["Golden App (ventas)", "Golden Caja", "Golden Legal"],
    test: /golden|dreamhabitat|legalgh/i,
  },
  { key: "broker-home", name: "Broker Home", apps: [], test: /julio\s+palli|broker\s*home/i },
  {
    key: "juris-pro",
    name: "Juris Pro",
    apps: ["Juris Pro App"],
    test: /christian\s+linares|juris\s*pro|chipana/i,
  },
  { key: "aurex", name: "Aurex", apps: [], test: /aurex/i },
];

const isEmailName = (name: string) => name.includes("@");

const ruleFor = (account: SaasAccount) => BUSINESS_RULES.find((r) => r.test.test(account.name));

const ruleRank = (account: SaasAccount) => {
  const i = BUSINESS_RULES.findIndex((r) => r.test.test(account.name));
  return i === -1 ? BUSINESS_RULES.length : i;
};

/** La base ya tiene la migración 081 si las filas traen la columna. */
export const hasBusinessColumns = (accounts: SaasAccount[]) =>
  accounts.some((a) => a.parent_account_id !== undefined);

/**
 * Agrupa las cuentas por negocio. Con la migración 081 manda lo guardado en
 * la base (parent_account_id y apps); sin ella, el nombre de la cuenta.
 */
export function groupAccountsByBusiness(accounts: SaasAccount[]): BusinessGroup[] {
  return hasBusinessColumns(accounts) ? groupByColumns(accounts) : groupByName(accounts);
}

function groupByColumns(accounts: SaasAccount[]): BusinessGroup[] {
  const ids = new Set(accounts.map((a) => a.id));
  // Una cuenta cuyo negocio ya no existe se muestra como negocio propio.
  const isTop = (a: SaasAccount) => !a.parent_account_id || !ids.has(a.parent_account_id);

  const tops = accounts
    .filter(isTop)
    .map((account, index) => ({ account, index }))
    .sort((a, b) => ruleRank(a.account) - ruleRank(b.account) || a.index - b.index)
    .map(({ account }) => account);

  return tops.map((primary) => {
    const rule = ruleFor(primary);
    return {
      key: primary.id,
      name: rule?.name ?? primary.name,
      apps: primary.apps?.length ? primary.apps : [],
      primary,
      members: accounts.filter((a) => !isTop(a) && a.parent_account_id === primary.id),
    };
  });
}

function groupByName(accounts: SaasAccount[]): BusinessGroup[] {
  const buckets = new Map<string, { rule: BusinessRule; accounts: SaasAccount[] }>();
  for (const rule of BUSINESS_RULES) buckets.set(rule.key, { rule, accounts: [] });

  const unmatched: SaasAccount[] = [];
  for (const account of accounts) {
    const rule = ruleFor(account);
    if (rule) buckets.get(rule.key)!.accounts.push(account);
    else unmatched.push(account);
  }

  const groups: BusinessGroup[] = [];
  for (const { rule, accounts: list } of buckets.values()) {
    if (list.length === 0) continue;
    // La cuenta real es la que lleva nombre de empresa o de persona, no un correo,
    // y la más antigua si hay varias (José Chipana entró después que Christian).
    const named = list.filter((a) => !isEmailName(a.name));
    const primary = [...(named.length ? named : list)].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    )[0];
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

/** Apps que se ofrecen al editar: las de todos los negocios, sin repetir. */
export function knownApps(accounts: SaasAccount[]): string[] {
  const all = [...BUSINESS_RULES.flatMap((r) => r.apps), ...accounts.flatMap((a) => a.apps ?? [])];
  return [...new Set(all)].sort((a, b) => a.localeCompare(b, "es"));
}
