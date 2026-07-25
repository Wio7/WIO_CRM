// ============================================================
// Spanish number-to-words for legal amounts (Peru-style contracts):
// "170,000.00" + "PEN" → "CIENTO SETENTA MIL CON 00/100 SOLES".
//
// Pure + deterministic — no I/O, safe to unit test directly.
// Supports 0 to 999,999,999.99. Amounts outside that range fall
// back to a plain numeric string rather than throwing, since a
// malformed contract field shouldn't crash PDF generation.
// ============================================================

const UNITS = [
  '', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
]
const TEENS = [
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
]
const TWENTIES = [
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro',
  'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve',
]
const TENS = [
  '', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa',
]
const HUNDREDS = [
  '', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos',
]

const CURRENCY_NAMES: Record<string, string> = {
  PEN: 'SOLES',
  USD: 'DÓLARES',
}

/** Converts an integer 0–999 to words. */
function chunkToWords(n: number): string {
  if (n === 0) return ''
  if (n < 10) return UNITS[n]
  if (n < 20) return TEENS[n - 10]
  if (n < 30) return TWENTIES[n - 20]
  if (n < 100) {
    const tens = Math.floor(n / 10)
    const rest = n % 10
    return rest === 0 ? TENS[tens] : `${TENS[tens]} y ${UNITS[rest]}`
  }
  if (n === 100) return 'cien'
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  return rest === 0 ? HUNDREDS[hundreds] : `${HUNDREDS[hundreds]} ${chunkToWords(rest)}`
}

/** Converts a non-negative integer (0–999,999,999) to words. */
export function enteroALetras(n: number): string {
  if (n === 0) return 'cero'
  if (n < 0 || n > 999_999_999 || !Number.isFinite(n)) return String(n)

  const millions = Math.floor(n / 1_000_000)
  const thousands = Math.floor((n % 1_000_000) / 1000)
  const rest = n % 1000

  const parts: string[] = []

  if (millions > 0) {
    parts.push(millions === 1 ? 'un millón' : `${chunkToWords(millions)} millones`)
  }
  if (thousands > 0) {
    parts.push(thousands === 1 ? 'mil' : `${chunkToWords(thousands)} mil`)
  }
  if (rest > 0) {
    parts.push(chunkToWords(rest))
  }

  return parts.join(' ')
}

/**
 * Formats a monetary amount as the legal words used on Peruvian
 * contracts/checks, e.g. `montoALetras(170000, 'PEN')` →
 * `"CIENTO SETENTA MIL CON 00/100 SOLES"`.
 */
export function montoALetras(amount: number, currency: string = 'PEN'): string {
  const abs = Math.abs(amount)
  const soles = Math.floor(abs)
  const cents = Math.round((abs - soles) * 100)
    .toString()
    .padStart(2, '0')

  const currencyName = CURRENCY_NAMES[currency] ?? currency
  const words = enteroALetras(soles)
  return `${words} CON ${cents}/100 ${currencyName}`.toUpperCase()
}
