import { describe, expect, it } from 'vitest';

import { SNOOZE_MS, isAppleMobile, shouldShowInstallHint } from './install-hint';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPADOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

const base = { userAgent: IPHONE, maxTouchPoints: 5, standalone: false, snoozedAt: null, now: 1_000_000_000_000 };

describe('isAppleMobile', () => {
  it('detects iPhone and iPadOS, not a real Mac or Android', () => {
    expect(isAppleMobile(IPHONE, 5)).toBe(true);
    expect(isAppleMobile(IPADOS, 5)).toBe(true);
    expect(isAppleMobile(IPADOS, 0)).toBe(false);
    expect(isAppleMobile(ANDROID, 5)).toBe(false);
  });
});

describe('shouldShowInstallHint', () => {
  it('shows on an iPhone browser tab', () => {
    expect(shouldShowInstallHint(base)).toBe(true);
  });

  it('hides once opened from the Home Screen', () => {
    expect(shouldShowInstallHint({ ...base, standalone: true })).toBe(false);
  });

  it('hides on Android', () => {
    expect(shouldShowInstallHint({ ...base, userAgent: ANDROID })).toBe(false);
  });

  it('stays hidden for a week after "Ahora no", then comes back', () => {
    expect(shouldShowInstallHint({ ...base, snoozedAt: base.now - 1000 })).toBe(false);
    expect(shouldShowInstallHint({ ...base, snoozedAt: base.now - SNOOZE_MS - 1 })).toBe(true);
  });
});
