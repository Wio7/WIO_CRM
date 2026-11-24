// Cuenta propia de Bryce. Se ve como "Wio Suite" y tiene su app aparte, pero en
// la base sigue llamándose "Aurex": varias apps y el formulario público de
// demos la buscan por ese nombre. Por eso se reconoce por id.
export const CUENTA_WIO_ID = "225298bc-5082-437c-a00f-f254e2141ed9";
export const APP_WIO_URL = "https://wio-suite-cuenta.vercel.app";

export const esCuentaWio = (id?: string | null) => id === CUENTA_WIO_ID;

export function nombreVisible(account: { id: string; name: string }): string {
  return esCuentaWio(account.id) ? "Wio Suite" : account.name;
}
