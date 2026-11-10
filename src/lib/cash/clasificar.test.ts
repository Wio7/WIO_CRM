import { describe, expect, it } from 'vitest';
import { proponerClasificacion, RUBROS } from './clasificar';

const colinas = ['I', 'II', 'III', 'IV'].map((n, i) => ({ id: `c${i + 1}`, name: `Las Colinas del Este — Etapa ${n}` }));
const sol = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, name: `Puesta del Sol ${n}` }));
const proyectos = [...colinas, ...sol, { id: 'bv', name: 'Blue Village' }, { id: 'dr', name: 'Dream' }, { id: 'eu', name: 'Eucaliptos' }];

describe('proponerClasificacion: rubro', () => {
  it('gasolina combi -> combi', () => {
    expect(proponerClasificacion('Gasolina combi', proyectos).rubro).toBe('combi');
    expect(proponerClasificacion('GASOLINA COMBÍ', proyectos).rubro).toBe('combi');
    expect(proponerClasificacion('peaje', proyectos).rubro).toBe('combi');
  });
  it('volantes y pauta -> marketing', () => {
    expect(proponerClasificacion('volantes', proyectos).rubro).toBe('marketing');
    expect(proponerClasificacion('Pauta en Facebook', proyectos).rubro).toBe('marketing');
    expect(proponerClasificacion('pago de publicidad', proyectos).rubro).toBe('marketing');
  });
  it('materiales y obra -> obra', () => {
    expect(proponerClasificacion('cemento y fierro', proyectos).rubro).toBe('obra');
    expect(proponerClasificacion('pago volquete', proyectos).rubro).toBe('obra');
  });
  it('sueldos -> personal; proveedor -> proveedores', () => {
    expect(proponerClasificacion('adelanto de sueldo', proyectos).rubro).toBe('personal');
    expect(proponerClasificacion('pago a proveedor', proyectos).rubro).toBe('proveedores');
  });
  it('en empate gana el orden combi, marketing, obra, personal, proveedores', () => {
    expect(proponerClasificacion('pago proveedor cemento', proyectos).rubro).toBe('obra');
  });
  it('no inventa: sin palabras conocidas queda sin rubro', () => {
    expect(proponerClasificacion('varios', proyectos).rubro).toBeNull();
    expect(proponerClasificacion('', proyectos).rubro).toBeNull();
  });
  it('solo devuelve rubros validos', () => {
    for (const t of ['combi', 'volantes', 'cemento', 'sueldo', 'proveedor']) {
      expect(RUBROS).toContain(proponerClasificacion(t, proyectos).rubro);
    }
  });
});

describe('proponerClasificacion: proyecto', () => {
  it('nombre de proyecto en el texto -> ese proyecto', () => {
    const r = proponerClasificacion('volantes Blue Village', proyectos);
    expect(r).toMatchObject({ rubro: 'marketing', projectId: 'bv', projectName: 'Blue Village' });
    expect(proponerClasificacion('letrero dream', proyectos).projectId).toBe('dr');
  });
  it('etapa con numero o romano', () => {
    expect(proponerClasificacion('cemento Colinas del Este 2', proyectos).projectId).toBe('c2');
    expect(proponerClasificacion('cemento colinas IV', proyectos).projectId).toBe('c4');
    expect(proponerClasificacion('volantes puesta del sol 3', proyectos).projectId).toBe('s3');
    expect(proponerClasificacion('Las Colinas del Este — Etapa I cemento', proyectos).projectId).toBe('c1');
  });
  it('ambiguo no adivina', () => {
    expect(proponerClasificacion('volantes colinas', proyectos).projectId).toBeNull();
    expect(proponerClasificacion('cemento colinas 120', proyectos).projectId).toBeNull();
    expect(proponerClasificacion('puesta del sol', proyectos).projectId).toBeNull();
  });
  it('un proyecto unico se reconoce por su palabra principal', () => {
    expect(proponerClasificacion('agua eucaliptos', proyectos).projectId).toBe('eu');
  });
  it('sin proyectos o sin coincidencia -> null', () => {
    expect(proponerClasificacion('cemento colinas 2', []).projectId).toBeNull();
    expect(proponerClasificacion('gasolina combi', proyectos).projectId).toBeNull();
    expect(proponerClasificacion('gasolina combi', proyectos).projectName).toBeNull();
  });
});
