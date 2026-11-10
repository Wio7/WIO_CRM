import { describe, expect, it } from 'vitest';

import {
  acceptHandoff,
  destinationReady,
  listHandoffs,
  returnHandoff,
  sendHandoff,
} from './rpc';

type Call = { fn: string; args: Record<string, unknown> };

function fakeClient(result: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: result.data ?? null, error: result.error ?? null };
      },
    },
  };
}

const missing = { code: 'PGRST202', message: 'Could not find the function' };

describe('errores', () => {
  it('PGRST202 marca missing085', async () => {
    const { client } = fakeClient({ error: missing });
    const r = await acceptHandoff(client, 'h1');
    expect(r).toMatchObject({ ok: false, missing085: true });
    expect((r as { message: string }).message).toContain('085');
  });
  it('error normal devuelve el mensaje de la base', async () => {
    const { client } = fakeClient({ error: { message: 'No autorizado' } });
    expect(await acceptHandoff(client, 'h1')).toEqual({ ok: false, missing085: false, message: 'No autorizado' });
  });
});

describe('sendHandoff', () => {
  it('llama a send_handoff y devuelve el id', async () => {
    const { client, calls } = fakeClient({ data: 'new-id' });
    const r = await sendHandoff(client, { kind: 'pase_legal', entityId: 'p1', note: 'urgente' });
    expect(r).toEqual({ ok: true, data: 'new-id' });
    expect(calls[0]).toEqual({
      fn: 'send_handoff',
      args: { p_kind: 'pase_legal', p_entity_id: 'p1', p_note: 'urgente', p_topic: null },
    });
  });
  it('postventa sin tema no llama a la RPC', async () => {
    const { client, calls } = fakeClient({ data: 'x' });
    const r = await sendHandoff(client, { kind: 'postventa_desde_cobranzas', entityId: 'c1' });
    expect(r).toEqual({ ok: false, missing085: false, message: 'Elige el tema del caso' });
    expect(calls).toHaveLength(0);
  });
  it('postventa con tema envía', async () => {
    const { client, calls } = fakeClient({ data: 'x' });
    const r = await sendHandoff(client, { kind: 'postventa_desde_legal', entityId: 'c1', topic: 'entrega' });
    expect(r.ok).toBe(true);
    expect(calls[0].args).toMatchObject({ p_topic: 'entrega', p_note: null });
  });
});

describe('returnHandoff', () => {
  it('motivo vacío no llama a la RPC', async () => {
    const { client, calls } = fakeClient({});
    expect(await returnHandoff(client, 'h1', '   ')).toEqual({ ok: false, missing085: false, message: 'Escribe el motivo' });
    expect(calls).toHaveLength(0);
  });
  it('con motivo llama a return_handoff', async () => {
    const { client, calls } = fakeClient({});
    expect((await returnHandoff(client, 'h1', ' falta DNI ')).ok).toBe(true);
    expect(calls[0]).toEqual({ fn: 'return_handoff', args: { p_id: 'h1', p_reason: 'falta DNI' } });
  });
});

describe('listHandoffs y destinationReady', () => {
  it('listHandoffs devuelve las filas', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 'h1' }] });
    const r = await listHandoffs(client, 'legal', 'recibidos');
    expect(r).toEqual({ ok: true, data: [{ id: 'h1' }] });
    expect(calls[0]).toEqual({ fn: 'my_handoffs', args: { p_module: 'legal', p_box: 'recibidos' } });
  });
  it('listHandoffs sin datos devuelve lista vacía', async () => {
    const { client } = fakeClient({ data: null });
    expect(await listHandoffs(client, 'legal', 'enviados')).toEqual({ ok: true, data: [] });
  });
  it('destinationReady devuelve booleano', async () => {
    const { client, calls } = fakeClient({ data: true });
    expect(await destinationReady(client, 'pase_legal')).toEqual({ ok: true, data: true });
    expect(calls[0]).toEqual({ fn: 'handoff_destination_ready', args: { p_kind: 'pase_legal' } });
  });
});
