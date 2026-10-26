import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Eliminar tus datos",
  description: "Cómo pedir la eliminación de tus datos en Wio CRM.",
};

export default function EliminarDatosPage() {
  return (
    <>
      <h1>Cómo eliminar tus datos</h1>

      <h2>Si eres una empresa cliente de Wio CRM</h2>
      <ul>
        <li>
          Escribe a <a href="mailto:contacto@wiocompany.com">contacto@wiocompany.com</a>{" "}
          desde el correo del administrador de la cuenta, con el asunto &quot;Eliminar datos&quot; y el nombre de tu empresa.
        </li>
        <li>Confirmaremos la solicitud y eliminaremos la cuenta, sus contactos, conversaciones y tokens de Meta en un máximo de 30 días.</li>
        <li>Si lo pides, antes te enviamos una exportación de tus datos.</li>
        <li>
          Para cortar el acceso de Wio a tu WhatsApp, Facebook o Instagram de inmediato, también puedes quitar la
          app &quot;WIO.CRM&quot; en Facebook → Configuración → Integraciones empresariales.
        </li>
      </ul>

      <h2>Si escribiste a una empresa que usa Wio CRM</h2>
      <ul>
        <li>Tus datos los administra esa empresa. Pídele directamente que los borre.</li>
        <li>
          Si no sabes cuál es o no te responde, escríbenos a{" "}
          <a href="mailto:contacto@wiocompany.com">contacto@wiocompany.com</a> con tu número de WhatsApp y el nombre
          de la empresa; la contactaremos para atender tu pedido.
        </li>
      </ul>

      <h2>Si conectaste Wio CRM con Facebook</h2>
      <p>
        Desde Facebook → Configuración → Integraciones empresariales, quita &quot;WIO.CRM&quot;. Para borrar también lo
        que ya se guardó, escríbenos como se indica arriba.
      </p>

      <p>
        Más detalle en la <a href="/privacidad">política de privacidad</a>.
      </p>
    </>
  );
}
