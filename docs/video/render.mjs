// Renders docs/video/scene.html to a folder of frames through Chrome's
// DevTools protocol (no dependencies; Node 22+), one frame per 1/FPS second.
//
//   node docs/video/render.mjs <out-folder>            every frame
//   node docs/video/render.mjs <out-folder> 5 12.5 30  stills at those seconds
//
// Then encode with ffmpeg:
//   ffmpeg -framerate 30 -i <out-folder>/%04d.png -c:v libx264 -crf 20 \
//     -pix_fmt yuv420p -movflags +faststart docs/konnash-intro.mp4
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FPS = 30;
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || "frames");
const stills = process.argv.slice(3).map(Number);
mkdirSync(out, { recursive: true });

const CHROMES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const chrome = CHROMES.find((p) => existsSync(p));
if (!chrome) throw new Error("Chrome or Edge not found; set CHROME to its path");

const port = 9300 + Math.floor(Math.random() * 500);
const profile = join(out, ".profile");
const child = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1920,1080",
  "--no-first-run", "--disable-gpu-vsync", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targetURL() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await targetURL());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "script error");
  return r.result.value;
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: pathToFileURL(join(here, "scene.html")).href });
await sleep(1500);
await evaluate("window.ready");
await sleep(500);
const duration = await evaluate("window.DURATION");

async function frame(t, file) {
  await evaluate(`renderAt(${t})`);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
}

if (stills.length) {
  for (const t of stills) await frame(t, join(out, `still-${t}.png`));
} else {
  const total = Math.round(duration * FPS);
  for (let i = 0; i < total; i++) {
    await frame(i / FPS, join(out, `${String(i).padStart(4, "0")}.png`));
    if (i % 90 === 0) console.log(`${i}/${total}`);
  }
}
ws.close();
child.kill();
