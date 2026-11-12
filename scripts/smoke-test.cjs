// Loads the built plugin script in a sandbox shaped like Zotero's plugin
// sandbox (no console, fetch or other web APIs of its own; those live on
// the main window), runs startup, then asks a question through the bundled
// AI client against a local mock Anthropic server.
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");

const calls = [];
function mock(name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => name;
      if (prop === Symbol.iterator) return [][Symbol.iterator];
      if (prop === "map") return () => [];
      return mock(`${name}.${String(prop)}`);
    },
    apply() {
      calls.push(name);
      return mock(`${name}()`);
    },
    construct() {
      return mock(`new ${name}`);
    },
  });
}

// Web APIs exist only on the (fake) main window, as in Zotero
const quiet = { ...console, log() {}, trace() {}, info() {}, debug() {}, warn() {} };
const windowWebAPIs = {
  console: quiet,
  fetch, Headers, Request, Response, ReadableStream, TextDecoder, TextEncoder,
  AbortController, AbortSignal, URL, URLSearchParams, FormData, Blob, File,
  DOMException, setTimeout, clearTimeout,
};
// Everything else on the window (document, …) is a generic mock
const windowMock = mock("window");
const mainWindow = new Proxy(windowWebAPIs, {
  get: (t, p) => (p in t ? t[p] : windowMock[p]),
});

const zoteroOwn = {
  initializationPromise: Promise.resolve(),
  unlockPromise: Promise.resolve(),
  uiReadyPromise: Promise.resolve(),
  getMainWindows: () => [],
  getMainWindow: () => mainWindow,
};
const zoteroSet = {};
const Zotero = new Proxy(mock("Zotero"), {
  get: (t, p) =>
    p in zoteroOwn ? zoteroOwn[p] : p in zoteroSet ? zoteroSet[p] : p === "Konnash" ? undefined : t[p],
  set: (_t, p, v) => ((zoteroSet[p] = v), true),
});

const ctx = {
  rootURI: "jar:file:///konnash.xpi!/",
  Zotero,
  Components: mock("Components"),
  ChromeUtils: mock("ChromeUtils"),
  Services: mock("Services"),
  Localization: function () {},
};
ctx._globalThis = ctx;
vm.createContext(ctx);
// V8 gives every context a console; Zotero's plugin sandbox has none
vm.runInContext("delete globalThis.console", ctx);
// Make sure no web APIs are reachable except through the main window
for (const name of ["console", "fetch", "TextDecoder", "setTimeout"]) {
  if (vm.runInContext(`typeof ${name}`, ctx) !== "undefined") {
    throw new Error(`Sandbox unexpectedly has ${name}`);
  }
}

function fail(message, error) {
  console.error("Smoke test FAILED:", message, error || "");
  process.exit(1);
}

function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

async function main() {
  const script = path.join(__dirname, "../.scaffold/build/addon/content/scripts/konnash.js");
  vm.runInContext(fs.readFileSync(script, "utf8"), ctx, { filename: "konnash.js" });
  const instance = zoteroSet.Konnash;
  if (!instance) fail("plugin script did not register Zotero.Konnash");
  await instance.hooks.onStartup();
  if (!calls.some((c) => c.includes("ItemPaneManager.registerSection"))) {
    fail("reader section was not registered");
  }
  if (calls.filter((c) => c.includes("Reader.registerEventListener")).length < 2) {
    fail("Explain entry points (context menu, selection popup) were not registered");
  }

  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", {
        message: {
          id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5",
          content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 },
        },
      });
      sse(res, "content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
      sse(res, "content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Reading the greeting." } });
      sse(res, "content_block_stop", { index: 0 });
      sse(res, "content_block_start", { index: 1, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { index: 1, delta: { type: "text_delta", text: "Hello" } });
      sse(res, "content_block_delta", {
        index: 1,
        delta: {
          type: "citations_delta",
          citation: {
            type: "content_block_location", cited_text: "Hello.", document_index: 0,
            document_title: "T", start_block_index: 0, end_block_index: 1,
          },
        },
      });
      sse(res, "content_block_stop", { index: 1 });
      sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      sse(res, "message_stop", {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const doc = {
    attachmentID: 1,
    pageCount: 1,
    pageLabels: [""],
    pageHeights: [792],
    outline: [{ title: "Introduction", level: 0, paragraph: 0 }],
    paragraphs: [
      { id: "P1", index: 0, kind: "paragraph", auxiliary: false, text: "Hello. World.", sentences: [0, 1], charPos: [] },
    ],
    sentences: [
      { id: "S1", index: 0, paragraph: 0, start: 0, end: 6, text: "Hello." },
      { id: "S2", index: 1, paragraph: 0, start: 7, end: 13, text: "World." },
    ],
  };
  try {
    const result = await instance.api.ask({
      doc,
      title: "T",
      history: [],
      question: "Hi?",
      settings: {
        preset: { id: "anthropic", label: "Anthropic", protocol: "anthropic", tier: "native" },
        baseURL: `http://127.0.0.1:${server.address().port}`,
        model: "claude-opus-5-5",
        apiKey: "test",
        effort: "medium",
      },
      signal: new AbortController().signal,
      onUpdate: () => {},
    });
    if (result.text !== "Hello [S1]") fail(`unexpected answer: ${JSON.stringify(result.text)}`);
    if (result.thinking !== "Reading the greeting.") fail(`reasoning not received: ${JSON.stringify(result.thinking)}`);
  } catch (e) {
    fail("ask() threw inside the sandbox", e);
  } finally {
    server.close();
  }
  console.log("Smoke test passed: loads, registers the Konnash section and Explain hooks, and streams a cited answer in a Zotero-like sandbox.");
}

main().catch((e) => fail("unexpected error", e));
