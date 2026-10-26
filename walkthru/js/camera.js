// The phone camera in the browser: no app needed. Falls back to the file picker (which on phones
// still opens the camera) when live video isn't available or allowed.

import { canvasToBlob, fit } from './imaging.js';

export const cameraSupported = () => Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;

/** Open the rear camera. Resolves to a MediaStream; rejects if permission is denied or none exists. */
export function openCamera() {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
  });
}

/** Show a stream in a <video>. Safe to call again with a new element after a re-render. */
export async function attach(video, stream) {
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay can be refused until a tap; the next tap retries */ }
}

export function stopCamera(stream) {
  for (const t of stream?.getTracks() || []) t.stop();
}

/** Grab the current video frame as a JPEG. Returns { blob, width, height }. */
export async function grabFrame(video) {
  // Right after a screen change the preview may not have its first frame yet; give it a moment
  // rather than failing a quick tap.
  if (!video.videoWidth) {
    await new Promise((resolve) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }
  const { w, h } = fit(video.videoWidth, video.videoHeight);
  if (!w || !h) throw new Error('The camera is not ready yet');
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  return { blob: await canvasToBlob(c), width: w, height: h };
}

/**
 * The web server's clock, read from the Date header of a tiny same-origin request. It is a
 * second opinion on the phone's clock (a phone's clock can be set to any date). Resolves to an
 * ISO string, or null when offline or the header is missing.
 */
export async function serverTime(timeoutMs = 3000) {
  if (location.protocol === 'file:') return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${location.pathname}?t=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
    const d = res.headers.get('date');
    const t = d ? Date.parse(d) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds between the phone clock and the server clock, or null if unknown. */
export function clockSkew(capturedAt, serverAt) {
  if (!serverAt) return null;
  return Math.round((Date.parse(capturedAt) - Date.parse(serverAt)) / 1000);
}

/** Capture checks shown on reports: plain warnings a reviewer should know about. */
export function captureWarnings(photo) {
  const out = [];
  if (photo.source === 'upload') out.push('Chosen from the photo library, not taken live.');
  if (photo.source === 'demo') out.push('Demo photo, drawn by the prototype.');
  const skew = clockSkew(photo.capturedAt, photo.serverTime);
  if (skew != null && Math.abs(skew) > 120) out.push(`Phone clock was ${Math.round(Math.abs(skew) / 60)} min ${skew > 0 ? 'ahead of' : 'behind'} the server.`);
  if (photo.source !== 'demo' && !photo.serverTime) out.push('Server clock not reached; time is from the phone only.');
  return out;
}
