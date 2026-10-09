/** CPU fixture canvas supplied explicitly; no implicit document/realm/device. */
export function canvasRealm(width: number, height: number): HTMLCanvasElement {
  const canvas = { width, height };
  const context = { canvas, clearRect() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, translate() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    measureText: () => ({ width: 20 }), getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 1 };
  return Object.assign(canvas, { getContext: () => context }) as unknown as HTMLCanvasElement;
}
