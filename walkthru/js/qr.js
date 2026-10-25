// QR codes as inline SVG, using the vendored qrcode-generator for the encoding.

import qrcode from '../vendor/qrcode.mjs';

/**
 * An SVG string for `text`. Error correction level M survives a scuffed door sign; type 0 lets
 * the library pick the smallest version that fits. Modules are drawn as one path.
 */
export function qrSvg(text, { label = 'QR code' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const safe = label.replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${safe}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
