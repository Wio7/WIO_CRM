/**
 * When to show the "install on your iPhone" hint. iOS has no install
 * prompt (beforeinstallprompt is Chromium-only), so the only way in is
 * Share -> Add to Home Screen, and people need to be told the steps.
 */

/** iPhone, iPod and iPad, including iPadOS that reports itself as a Mac. */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Hidden after "Ahora no" for this long, then offered again. */
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldShowInstallHint(input: {
  userAgent: string;
  maxTouchPoints: number;
  /** Already opened from the Home Screen icon. */
  standalone: boolean;
  /** Epoch ms of the last "Ahora no", if any. */
  snoozedAt: number | null;
  now: number;
}): boolean {
  if (input.standalone) return false;
  if (!isAppleMobile(input.userAgent, input.maxTouchPoints)) return false;
  if (input.snoozedAt !== null && input.now - input.snoozedAt < SNOOZE_MS) return false;
  return true;
}
