import { describe, expect, it } from "vitest";
import { isBlankImage } from "./imageryPagePreparation";

describe("isBlankImage", () => {
  it("treats a fully transparent image as having no data, whatever its colour channels hold", () => {
    const rgba = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba[i] = 30;
    expect(isBlankImage(rgba)).toBe(true);
  });

  it("keeps an image with any visible pixel, and an opaque black one", () => {
    const partly = new Uint8ClampedArray(256 * 256 * 4);
    partly[256 * 256 * 4 - 1] = 1;
    expect(isBlankImage(partly)).toBe(false);
    const black = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    expect(isBlankImage(black)).toBe(false);
  });
});
