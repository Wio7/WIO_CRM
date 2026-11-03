import type { MessageTemplateStatus } from '@/types';

/** Default opt-out footer; the webhook turns a "BAJA" reply into an opt-out. */
export const OPT_OUT_FOOTER = 'Responde BAJA si no deseas recibir más mensajes';

/**
 * Meta template names allow only a-z, 0-9 and "_". Turn whatever the user
 * typed ("Recordatorio Noviembre!") into one ("recordatorio_noviembre").
 */
export function templateNameFromTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/** Plain-language status for people who have never seen Meta's states. */
export function templateStatusText(status: MessageTemplateStatus | undefined): {
  label: string;
  hint: string;
  tone: 'ok' | 'wait' | 'bad';
} {
  switch (status) {
    case 'APPROVED':
      return { label: 'Aprobada', hint: 'Ya puedes usarla en una campaña.', tone: 'ok' };
    case 'PENDING':
    case 'IN_APPEAL':
      return { label: 'En revisión', hint: 'WhatsApp la está revisando; suele tardar minutos u horas.', tone: 'wait' };
    case 'REJECTED':
      return { label: 'Rechazada', hint: 'WhatsApp no la aceptó. Cambia el texto y créala de nuevo.', tone: 'bad' };
    case 'PAUSED':
      return { label: 'Pausada', hint: 'Muchas personas la bloquearon o reportaron. Revisa el texto.', tone: 'bad' };
    case 'DISABLED':
      return { label: 'Desactivada', hint: 'WhatsApp la desactivó. Crea una nueva con otro texto.', tone: 'bad' };
    case 'DRAFT':
      return { label: 'Sin enviar', hint: 'No llegó a WhatsApp. Intenta crearla otra vez.', tone: 'wait' };
    default:
      return { label: 'Desconocido', hint: 'Toca "Actualizar estados".', tone: 'wait' };
  }
}
