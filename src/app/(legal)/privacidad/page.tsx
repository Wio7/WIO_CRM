import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de privacidad",
  description: "Cómo Wio CRM trata los datos personales de sus clientes y de los contactos que estos gestionan.",
};

const UPDATED = "25 de octubre de 2026";

export default function PrivacidadPage() {
  return (
    <>
      <h1>Política de privacidad</h1>
      <p className="text-sm text-muted-foreground">Última actualización: {UPDATED}</p>

      <p>
        Wio CRM (wiocompany.com) es un software de gestión de clientes con WhatsApp, operado por Bryce Luis
        Alexander Bueno Sarmiento, RUC 10730253350, con domicilio en Ica, Perú (en adelante, &quot;Wio&quot;). Esta
        política explica qué datos personales tratamos, para qué, con quién los compartimos y cómo ejercer tus
        derechos, conforme a la Ley N.° 29733, Ley de Protección de Datos Personales, y su reglamento.
      </p>

      <h2>1. Dos tipos de datos y dos roles</h2>
      <ul>
        <li>
          <strong>Datos de nuestros clientes y sus usuarios</strong> (empresas que contratan Wio CRM y las personas de
          su equipo): Wio es el <strong>responsable</strong> de estos datos.
        </li>
        <li>
          <strong>Datos de los contactos de nuestros clientes</strong> (las personas que escriben al WhatsApp,
          Messenger o Instagram de esas empresas, o que llenan sus formularios): la empresa cliente es la
          responsable y Wio actúa como <strong>encargado del tratamiento</strong>, siguiendo sus instrucciones. Si
          eres uno de esos contactos, para ejercer tus derechos escribe primero a la empresa con la que hablaste;
          también puedes escribirnos y la contactaremos.
        </li>
      </ul>

      <h2>2. Qué datos tratamos</h2>
      <ul>
        <li>Cuenta: nombre, correo, teléfono, empresa, rol y credenciales de acceso (la contraseña se guarda cifrada).</li>
        <li>
          Mensajería: números de WhatsApp, nombre de perfil, contenido de los mensajes, archivos enviados y
          recibidos, estado de entrega y fecha. Si la empresa conecta su WhatsApp Business en modo coexistencia,
          también los mensajes que envía desde su celular, sus contactos y hasta 180 días de historial que la
          empresa decida compartir.
        </li>
        <li>Contactos y ventas: datos que la empresa registra de sus clientes (nombre, teléfono, correo, notas, etapa de venta, citas).</li>
        <li>Integraciones: identificadores y tokens de acceso de Meta (WhatsApp, Facebook, Instagram) y de Google, guardados cifrados.</li>
        <li>Uso técnico: registros de acceso, dirección IP, navegador y errores, para seguridad y soporte.</li>
      </ul>

      <h2>3. Para qué los usamos</h2>
      <ul>
        <li>Prestar el servicio: mostrar las conversaciones, enviar y recibir mensajes y plantillas, organizar contactos y ventas.</li>
        <li>Funciones de inteligencia artificial que la empresa active (respuestas sugeridas, resúmenes, asistentes).</li>
        <li>Seguridad, prevención de abuso, soporte técnico y mejora del servicio.</li>
        <li>Cumplir obligaciones legales y tributarias.</li>
      </ul>
      <p>No vendemos datos personales ni los usamos para publicidad propia.</p>

      <h2>4. Con quién los compartimos</h2>
      <p>Solo con proveedores necesarios para operar el servicio, que los tratan por cuenta nuestra:</p>
      <ul>
        <li>Meta Platforms (WhatsApp Business Platform, Facebook e Instagram), para enviar y recibir mensajes.</li>
        <li>Supabase, base de datos y autenticación.</li>
        <li>Vercel y Cloudflare, alojamiento y red.</li>
        <li>OpenAI y Anthropic, solo cuando la empresa usa funciones de inteligencia artificial.</li>
        <li>Google (Gmail) y Twilio, solo si la empresa conecta esas integraciones.</li>
      </ul>
      <p>
        Algunos de estos proveedores procesan datos fuera del Perú (por ejemplo, en Estados Unidos). Lo hacemos
        con las garantías que exige la Ley N.° 29733 para la transferencia internacional de datos. También
        compartiremos datos si una autoridad competente lo exige por ley.
      </p>

      <h2>5. Cuánto tiempo los guardamos</h2>
      <p>
        Mientras la empresa mantenga su cuenta activa. Al terminar el servicio, o si la empresa lo pide, eliminamos
        sus datos en un plazo máximo de 30 días, salvo lo que debamos conservar por obligación legal. Las copias de
        seguridad se borran en su ciclo normal de rotación.
      </p>

      <h2>6. Seguridad</h2>
      <p>
        Usamos conexiones cifradas (HTTPS), cifrado de tokens y credenciales, control de acceso por cuenta y por rol,
        y registro de actividad. Ningún sistema es infalible; si ocurre un incidente que afecte tus datos, te
        avisaremos según lo que exige la ley.
      </p>

      <h2>7. Tus derechos</h2>
      <p>
        Puedes pedir acceso, rectificación, cancelación u oposición (derechos ARCO) sobre tus datos escribiendo a{" "}
        <a href="mailto:contacto@wiocompany.com">contacto@wiocompany.com</a>. Respondemos en los plazos de la Ley N.°
        29733. Si no estás conforme con la respuesta, puedes acudir a la Autoridad Nacional de Protección de Datos
        Personales del Ministerio de Justicia y Derechos Humanos. Para borrar tus datos, revisa también{" "}
        <a href="/eliminar-datos">cómo eliminar tus datos</a>.
      </p>

      <h2>8. Menores de edad</h2>
      <p>Wio CRM es un servicio para empresas y no está dirigido a menores de 18 años.</p>

      <h2>9. Cambios</h2>
      <p>
        Si cambiamos esta política, publicaremos la nueva versión en esta página con su fecha. Si el cambio es
        importante, avisaremos a las empresas clientes por correo o dentro del CRM.
      </p>

      <h2>10. Contacto</h2>
      <p>
        Bryce Luis Alexander Bueno Sarmiento · RUC 10730253350 · Ica, Perú ·{" "}
        <a href="mailto:contacto@wiocompany.com">contacto@wiocompany.com</a>
      </p>
    </>
  );
}
