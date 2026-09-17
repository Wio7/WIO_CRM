import { describe, expect, it } from "vitest";

import {
  MAX_FAILS_PER_PHONE,
  MAX_TRIES_PER_IP,
  PHONE_WINDOW_MS,
  firstName,
  hashSessionToken,
  ipLockedUntil,
  maskPhone,
  newSessionToken,
  normalizeDni,
  phoneCandidates,
  phoneKey,
  phoneLockedUntil,
  sameSecret,
} from "./identity";

const NOW = Date.parse("2026-09-17T15:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("phoneCandidates", () => {
  it("matches a 9-digit Peruvian mobile with and without the country code", () => {
    expect(phoneCandidates("987 654 321").sort()).toEqual(["51987654321", "987654321"]);
    expect(phoneCandidates("+51 987-654-321").sort()).toEqual(["51987654321", "987654321"]);
    expect(phoneCandidates("0051987654321").sort()).toEqual(["51987654321", "987654321"]);
  });

  it("leaves other numbers as typed", () => {
    expect(phoneCandidates("+1 555 123 4567")).toEqual(["15551234567"]);
  });

  it("rejects what can't be a phone", () => {
    expect(phoneCandidates("")).toEqual([]);
    expect(phoneCandidates("12345")).toEqual([]);
  });

  it("records attempts under one key whatever the format", () => {
    expect(phoneKey("987654321")).toBe("51987654321");
    expect(phoneKey("+51987654321")).toBe("51987654321");
  });
});

describe("normalizeDni", () => {
  it("keeps 8 to 12 digits and drops separators", () => {
    expect(normalizeDni("12345678")).toBe("12345678");
    expect(normalizeDni(" 12.345.678 ")).toBe("12345678");
    expect(normalizeDni("001234567890")).toBe("001234567890");
  });

  it("rejects letters and wrong lengths", () => {
    expect(normalizeDni("DNI 12345678")).toBeNull();
    expect(normalizeDni("1234567")).toBeNull();
    expect(normalizeDni("1234567890123")).toBeNull();
  });
});

describe("sameSecret", () => {
  it("compares exactly", () => {
    expect(sameSecret("12345678", "12345678")).toBe(true);
    expect(sameSecret("12345678", "12345679")).toBe(false);
    expect(sameSecret("12345678", "123456789")).toBe(false);
  });
});

describe("phoneLockedUntil", () => {
  const fail = (ms: number) => ({ succeeded: false, created_at: ago(ms) });
  const ok = (ms: number) => ({ succeeded: true, created_at: ago(ms) });

  it("allows up to four failures", () => {
    const tries = Array.from({ length: MAX_FAILS_PER_PHONE - 1 }, (_, i) => fail(i * 1000));
    expect(phoneLockedUntil(tries, NOW)).toBeNull();
  });

  it("locks on the fifth, until the oldest of them leaves the window", () => {
    const tries = Array.from({ length: MAX_FAILS_PER_PHONE }, (_, i) => fail(i * 60_000));
    expect(phoneLockedUntil(tries, NOW)).toBe(NOW - 4 * 60_000 + PHONE_WINDOW_MS);
  });

  it("forgets failures before a success", () => {
    const tries = [fail(1000), fail(2000), ok(3000), fail(4000), fail(5000), fail(6000)];
    expect(phoneLockedUntil(tries, NOW)).toBeNull();
  });

  it("forgets failures outside the window", () => {
    const tries = Array.from({ length: 5 }, () => fail(PHONE_WINDOW_MS + 1000));
    expect(phoneLockedUntil(tries, NOW)).toBeNull();
  });
});

describe("ipLockedUntil", () => {
  it("counts every try from the IP", () => {
    const tries = Array.from({ length: MAX_TRIES_PER_IP }, (_, i) => ({
      succeeded: i % 2 === 0,
      created_at: ago(i * 1000),
    }));
    expect(ipLockedUntil(tries, NOW)).not.toBeNull();
    expect(ipLockedUntil(tries.slice(1), NOW)).toBeNull();
  });
});

describe("session tokens", () => {
  it("are random and stored only as a hash", () => {
    const a = newSessionToken();
    expect(a).toHaveLength(43);
    expect(a).not.toBe(newSessionToken());
    expect(hashSessionToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a)).not.toContain(a);
  });
});

describe("greeting and hints", () => {
  it("takes the first name", () => {
    expect(firstName("juan carlos pérez")).toBe("Juan");
    expect(firstName("PEREZ ROJAS, JUAN CARLOS")).toBe("Juan");
    expect(firstName(null)).toBe("");
  });

  it("masks the phone", () => {
    expect(maskPhone("51987654321")).toBe("••• ••• 321");
  });
});
