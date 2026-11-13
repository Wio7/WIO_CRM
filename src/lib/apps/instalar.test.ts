import { describe, expect, it } from "vitest";

import { PASOS_INSTALAR, plataformaInstalar } from "./instalar";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

describe("plataformaInstalar", () => {
  it("distingue iPhone, Android y laptop", () => {
    expect(plataformaInstalar(IPHONE, 5)).toBe("iphone");
    expect(plataformaInstalar(ANDROID, 5)).toBe("android");
    expect(plataformaInstalar(WINDOWS, 0)).toBe("laptop");
  });

  it("cada plataforma tiene pasos", () => {
    for (const p of ["iphone", "android", "laptop"] as const) {
      expect(PASOS_INSTALAR[p].length).toBeGreaterThan(1);
    }
  });
});
