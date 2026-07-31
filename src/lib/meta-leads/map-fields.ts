// ============================================================
// Map a Meta lead form's field_data → CRM contact fields.
//
// Standard automatic mapping: Meta's built-in question names
// (full_name / first_name / last_name / phone_number / email) are
// detected automatically. Everything else (custom questions the account
// added to its form) is preserved verbatim as `extras`, which the
// webhook writes into a contact note so nothing the lead submitted is
// lost — without requiring per-form field-mapping configuration.
// ============================================================

import type { LeadFieldDatum } from '@/lib/meta-leads/graph';

export interface MappedLead {
  name?: string;
  phone?: string;
  email?: string;
  /** Non-standard questions, in form order: [label, answer] pairs. */
  extras: { label: string; value: string }[];
}

/** First non-empty value for a field, trimmed. */
function firstValue(datum: LeadFieldDatum): string {
  return (datum.values ?? []).map((v) => (v ?? '').trim()).find(Boolean) ?? '';
}

/** Normalize a Meta field name for matching (lowercase, no separators). */
function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

export function mapLeadFields(fieldData: LeadFieldDatum[]): MappedLead {
  let fullName = '';
  let firstName = '';
  let lastName = '';
  let phone = '';
  let email = '';
  const extras: { label: string; value: string }[] = [];

  for (const datum of fieldData ?? []) {
    const key = normalizeKey(datum.name ?? '');
    const value = firstValue(datum);
    if (!value) continue;

    switch (key) {
      case 'fullname':
        fullName = value;
        break;
      case 'firstname':
      case 'first':
        firstName = value;
        break;
      case 'lastname':
      case 'last':
        lastName = value;
        break;
      case 'phonenumber':
      case 'phone':
      case 'telefono':
      case 'teléfono':
      case 'celular':
        phone = value;
        break;
      case 'email':
      case 'correo':
      case 'correoelectronico':
        email = value;
        break;
      default:
        extras.push({ label: datum.name, value });
    }
  }

  const name = fullName || [firstName, lastName].filter(Boolean).join(' ');

  return {
    name: name || undefined,
    phone: phone || undefined,
    email: email || undefined,
    extras,
  };
}
