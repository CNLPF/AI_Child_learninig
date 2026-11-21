import { chromium } from 'playwright';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const useCamera = process.argv.includes('--camera');
const try60Fps = process.argv.includes('--try60');
const url = args[0] ?? 'http://127.0.0.1:5183/fruit.html?bot=1';
const durationMs = Number(args[1] ?? 8000);
const edgePath = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const browser = await chromium.launch({ executablePath: edgePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.__fruit), null, { timeout: 10000 });
if (new URL(url).searchParams.has('flow')) await page.evaluate(() => window.__fruit.activateFlow());

let cameraError = '';
if (useCamera) {
  await page.getByRole('button', { name: '开启摄像头', exact: true }).click();
  await page.waitForFunction(
    () => {
      const button = document.getElementById('camera');
      const status = document.getElementById('status');
      return (button && !button.disabled && status?.textContent !== '等待开始') || Boolean(document.getElementById('error')?.textContent);
    },
    null,
    { timeout: 30000 },
  );
  cameraError = (await page.locator('#error').textContent()) ?? '';
  if (try60Fps) {
    await page.evaluate(async () => {
      const video = document.getElementById('video');
      const track = video?.srcObject?.getVideoTracks?.()[0];
      if (!track) return;
      try {
        await track.applyConstraints({
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60, max: 60 },
        });
      } catch {
        // The capture device may not expose a 60 FPS mode.
      }
    });
  }
}
await page.waitForTimeout(2000);

const environment = await page.evaluate(() => {
  const video = document.getElementById('video');
  const track = video?.srcObject?.getVideoTracks?.()[0];
  const testCanvas = document.createElement('canvas');
  const gl = testCanvas.getContext('webgl2') ?? testCanvas.getContext('webgl');
  const debug = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    devicePixelRatio,
    videoWidth: video?.videoWidth ?? 0,
    videoHeight: video?.videoHeight ?? 0,
    trackSettings: track?.getSettings?.() ?? null,
    trackCapabilities: track?.getCapabilities?.() ?? null,
    webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
  };
});

const metrics = await page.evaluate(async (sampleMs) => {
  const media = document.getElementById('video');
  const startQuality = media?.getVideoPlaybackQuality?.();
  let videoFrameCallbacks = 0;
  let videoFrameHandle = 0;
  if (media?.requestVideoFrameCallback) {
    const countVideoFrames = () => {
      videoFrameCallbacks += 1;
      videoFrameHandle = media.requestVideoFrameCallback(countVideoFrames);
    };
    videoFrameHandle = media.requestVideoFrameCallback(countVideoFrames);
  }
  const intervals = [];
  let longTasks = 0;
  let longTaskMs = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks += 1;
      longTaskMs += entry.duration;
    }
  });
  try {
    observer.observe({ type: 'longtask' });
  } catch {
    // Long Task timing is optional in some browser builds.
  }
  if (window.__fruit?.hands?.tracker) window.__fruit.hands.tracker.maxDetectMs = 0;

  let last = performance.now();
  const started = last;
  await new Promise((resolve) => {
    const tick = (now) => {
      intervals.push(now - last);
      last = now;
      if (now - started < sampleMs) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  observer.disconnect();
  if (media?.cancelVideoFrameCallback && videoFrameHandle) media.cancelVideoFrameCallback(videoFrameHandle);
  const endQuality = media?.getVideoPlaybackQuality?.();

  const samples = intervals.slice(2).sort((a, b) => a - b);
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] ?? 0;
  const average = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  return {
    frames: samples.length,
    fps: +(1000 / average).toFixed(1),
    averageMs: +average.toFixed(2),
    p50Ms: +percentile(0.5).toFixed(2),
    p95Ms: +percentile(0.95).toFixed(2),
    p99Ms: +percentile(0.99).toFixed(2),
    maxMs: +Math.max(...samples).toFixed(2),
    over25ms: samples.filter((value) => value > 25).length,
    over50ms: samples.filter((value) => value > 50).length,
    longTasks,
    longTaskMs: +longTaskMs.toFixed(1),
    videoFrameCallbacks,
    newVideoFrames: startQuality && endQuality ? endQuality.totalVideoFrames - startQuality.totalVideoFrames : 0,
    droppedVideoFrames: startQuality && endQuality ? endQuality.droppedVideoFrames - startQuality.droppedVideoFrames : 0,
    score: window.__fruit?.score,
    fruits: window.__fruit?.fruits?.length,
    camera: {
      source: window.__fruit?.hands?.source,
      delegate: window.__fruit?.hands?.tracker?.delegate,
      trackerFps: window.__fruit?.hands?.tracker?.fps,
      detectMs: +(window.__fruit?.hands?.tracker?.averageDetectMs ?? 0).toFixed(2),
      maxDetectMs: +(window.__fruit?.hands?.tracker?.maxDetectMs ?? 0).toFixed(2),
      handsDetected: window.__fruit?.hands?.frame?.hands?.length ?? 0,
    },
  };
}, durationMs);

console.log(JSON.stringify({ url, cameraError, environment, ...metrics, pageErrors: errors }, null, 2));
await browser.close();
