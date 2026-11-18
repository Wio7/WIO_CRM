import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WhatsAppLinesList } from './whatsapp-lines-list';
import type { LineView } from '@/lib/whatsapp/lines-view';

const line = (over: Partial<LineView>): LineView => ({
  id: 'l1', phone_number_id: '111', line_name: 'Principal', area: null, logo_url: null,
  is_primary: true, status: 'connected', disconnected_at: null, sort_order: 0, ...over,
});

const noop = vi.fn();
const render = (lines: LineView[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <WhatsAppLinesList
      lines={lines}
      onSaveEdit={async () => true}
      onRemove={noop}
      onReconnect={noop}
      onAdvanced={noop}
      {...extra}
    />,
  );
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('WhatsAppLinesList', () => {
  it('con 2 líneas pinta 2 filas por vista (web y celular separadas)', () => {
    const html = render([
      line({}),
      line({ id: 'l2', phone_number_id: '222', line_name: 'Cobranzas', area: 'cobranzas', is_primary: false, sort_order: 1 }),
    ]);
    expect(count(html, 'data-line-row="desktop"')).toBe(2);
    expect(count(html, 'data-line-row="mobile"')).toBe(2);
    expect(html).toContain('Cobranzas');
    expect(html).toContain('222');
    expect(count(html, '>Principal</span>')).toBe(2); // la principal, una vez por vista
  });

  it('con 1 línea: una fila, badge Principal, Editar y Quitar, sin Reconectar', () => {
    const html = render([line({})]);
    expect(count(html, 'data-line-id=')).toBe(1);
    expect(html).toContain('Editar');
    expect(html).toContain('Quitar');
    expect(html).toContain('Conectada');
    expect(html).not.toContain('Reconectar');
    expect(html).not.toContain('Desconectada');
  });

  it('una línea con desconexión suave muestra Desconectada y Reconectar', () => {
    const html = render([line({ disconnected_at: '2026-11-18T00:00:00Z', status: 'disconnected' })]);
    expect(html).toContain('Desconectada');
    expect(html).toContain('Reconectar');
  });

  it('muestra el área con su etiqueta en español y las iniciales sin logo', () => {
    const html = render([line({ line_name: 'Cobranzas Lima', area: 'tecnica' })]);
    expect(html).toContain('Técnica');
    expect(html).toContain('>CL<');
  });

  it('con logo usa la imagen', () => {
    const html = render([line({ logo_url: 'https://x.test/l.png' })]);
    expect(html).toContain('src="https://x.test/l.png"');
  });

  it('no expone tokens', () => {
    const html = render([{ ...line({}), access_token: 'tok-secret' } as LineView]);
    expect(html).not.toContain('tok-secret');
  });

  it('abre el panel de reconexión solo de la línea indicada', () => {
    const html = render(
      [line({ disconnected_at: '2026-11-18T00:00:00Z' }), line({ id: 'l2', is_primary: false, sort_order: 1 })],
      { reconnectingId: 'l1', reconnectSlot: <span>SLOT</span> },
    );
    expect(count(html, 'data-line-reconnect')).toBe(1);
    expect(html).toContain('SLOT');
  });
});
