import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Términos del servicio",
  description: "Condiciones de uso de Wio CRM.",
};

const UPDATED = "25 de octubre de 2026";

export default function TerminosPage() {
  return (
    <>
      <h1>Términos del servicio</h1>
      <p className="text-sm text-muted-foreground">Última actualización: {UPDATED}</p>

      <p>
        Estos términos regulan el uso de Wio CRM (wiocompany.com), operado por Bryce Luis Alexander Bueno Sarmiento,
        RUC 10730253350, Ica, Perú (&quot;Wio&quot;). Al crear una cuenta o usar el servicio, la empresa cliente y sus
        usuarios aceptan estos términos.
      </p>

      <h2>1. El servicio</h2>
      <p>
        Wio CRM es un software para gestionar clientes y conversaciones de WhatsApp, Messenger e Instagram, con
        herramientas de ventas, plantillas, difusiones, automatizaciones y funciones de inteligencia artificial. El
        alcance, el precio y el plazo de cada implementación se acuerdan por escrito con cada empresa.
      </p>

      <h2>2. Cuentas</h2>
      <ul>
        <li>La empresa es responsable de quién accede a su cuenta y de lo que hacen sus usuarios.</li>
        <li>Las credenciales son personales; avísanos de inmediato si sospechas un acceso no autorizado.</li>
        <li>Para usar WhatsApp, la empresa conecta su propia cuenta de WhatsApp Business y su número.</li>
      </ul>

      <h2>3. Uso aceptable y reglas de WhatsApp</h2>
      <p>La empresa se compromete a:</p>
      <ul>
        <li>
          Cumplir las{" "}
          <a href="https://www.whatsapp.com/legal/business-policy/" target="_blank" rel="noreferrer">Políticas de WhatsApp Business</a>{" "}
          y las condiciones de Meta, incluido escribir con plantillas solo a personas que dieron su permiso.
        </li>
        <li>No enviar spam, contenido ilegal, engañoso u ofensivo, ni vender productos prohibidos por Meta.</li>
        <li>Tener una base legal para tratar los datos de sus contactos, conforme a la Ley N.° 29733.</li>
        <li>No intentar vulnerar, copiar o sobrecargar el servicio.</li>
      </ul>
      <p>
        Si una cuenta incumple estas reglas o pone en riesgo el servicio o los números de otros clientes, podemos
        suspenderla, avisando a la empresa cuando sea posible.
      </p>

      <h2>4. Costos de Meta</h2>
      <p>
        Los mensajes que Meta cobra (por ejemplo, plantillas de marketing o de utilidad) los paga la empresa
        directamente a Meta con su propio método de pago, aparte del precio de Wio CRM.
      </p>

      <h2>5. Datos</h2>
      <p>
        Los datos de la empresa y de sus contactos son de la empresa. Wio los trata solo para prestar el servicio,
        como encargado del tratamiento, según la <a href="/privacidad">política de privacidad</a>. Al terminar el
        servicio, la empresa puede pedir una exportación de sus datos antes de su eliminación.
      </p>

      <h2>6. Disponibilidad</h2>
      <p>
        Trabajamos para que el servicio esté disponible y funcione bien, pero depende también de terceros (Meta,
        proveedores de alojamiento, internet). No garantizamos que funcione sin interrupciones ni errores.
      </p>

      <h2>7. Responsabilidad</h2>
      <p>
        En la medida que la ley lo permita, Wio no responde por daños indirectos, lucro cesante ni por bloqueos o
        restricciones que Meta aplique a un número por el uso que haga la empresa. La responsabilidad total de Wio
        se limita a lo pagado por la empresa en los tres meses anteriores al hecho.
      </p>

      <h2>8. Cambios y terminación</h2>
      <p>
        Podemos actualizar estos términos; publicaremos la nueva versión aquí con su fecha y avisaremos los cambios
        importantes. La empresa puede dejar de usar el servicio cuando quiera, según lo acordado en su contrato.
      </p>

      <h2>9. Ley aplicable</h2>
      <p>Estos términos se rigen por las leyes del Perú.</p>

      <h2>10. Contacto</h2>
      <p>
        <a href="mailto:contacto@wiocompany.com">contacto@wiocompany.com</a>
      </p>
    </>
  );
}
