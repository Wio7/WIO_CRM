import {
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Megaphone,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'meta-leads',
  'templates',
  'fields',
  'deals',
  'members',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Vista General', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Tu Perfil', icon: User, group: 'account' },
  security: { id: 'security', label: 'Seguridad', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Apariencia', icon: Palette, group: 'account' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace' },
  'meta-leads': { id: 'meta-leads', label: 'Meta Lead Ads', icon: Megaphone, group: 'workspace' },
  templates: { id: 'templates', label: 'Plantillas', icon: FileText, group: 'workspace' },
  fields: { id: 'fields', label: 'Campos y Etiquetas', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'Negocios y Moneda', icon: Coins, group: 'workspace' },
  members: { id: 'members', label: 'Equipo', icon: UsersRound, group: 'workspace' },
  api: { id: 'api', label: 'Claves de API', icon: KeyRound, group: 'workspace' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Cuenta', group: 'account' },
  { label: 'Espacio de Trabajo', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
