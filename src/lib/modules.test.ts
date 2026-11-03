import { describe, expect, it } from 'vitest';

import { MODULE_OPTIONS, SIMPLE_VIEW_MODULES, isModuleDisabled, isSimpleAccount } from './modules';

describe('simple view', () => {
  it('keeps inbox, contacts and broadcasts on, everything else off', () => {
    for (const keep of ['/inbox', '/contacts', '/broadcasts', '/broadcasts/templates']) {
      expect(isModuleDisabled(keep, SIMPLE_VIEW_MODULES)).toBe(false);
    }
    for (const off of ['/pipelines', '/projects', '/dialer', '/flows', '/agents']) {
      expect(isModuleDisabled(off, SIMPLE_VIEW_MODULES)).toBe(true);
    }
  });

  it('never turns off the dashboard or settings', () => {
    expect(isModuleDisabled('/dashboard', SIMPLE_VIEW_MODULES)).toBe(false);
    expect(isModuleDisabled('/settings', SIMPLE_VIEW_MODULES)).toBe(false);
    expect(MODULE_OPTIONS.map((m) => m.href)).not.toContain('/dashboard');
  });

  it('an account without pipelines gets the simple home', () => {
    expect(isSimpleAccount(SIMPLE_VIEW_MODULES)).toBe(true);
    expect(isSimpleAccount([])).toBe(false);
    expect(isSimpleAccount(undefined)).toBe(false);
  });
});
