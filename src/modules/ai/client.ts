/**
 * Ask one document a question, streaming the answer as marker text
 * (see answer.ts). The model only ever sees this single document: all of
 * it, or the sentences the router selected.
 *
 * Also: askJSON() for small structured helper jobs (section summaries and
 * ranking), and anthropicClient() shared with the model list.
 */
import Anthropic from "@anthropic-ai/sdk";
import { KonnashDocument } from "../document";
import { SourceInfo } from "../structure";
import { blockRangeToSpec, stripMarkers } from "./answer";
import { buildDocumentContext, getSystemPrompt, toNumberedText } from "./prompt";
import { AISettings, supportsEffort } from "./providers";
import { hostWindow } from "../../utils/window";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AskResult {
  text: string;
  model: string;
  /** Set when the model declined to answer */
  refusal?: string;
  /** Set when a fallback model answered instead */
  fallbackModel?: string;
  truncated?: boolean;
  /** The model's reasoning summary, when the provider shares it */
  thinking?: string;
  thinkingMs?: number;
}

export interface AskOptions {
  doc: KonnashDocument;
  title: string;
  source?: SourceInfo;
  history: ChatTurn[];
  question: string;
  settings: AISettings;
  signal: AbortSignal;
  /** Sorted global sentence indexes to send instead of the whole document */
  selection?: number[];
  /** Added to the system prompt when only part of the document is sent */
  partialNote?: string;
  /** Called with the full answer text so far */
  onUpdate: (text: string) => void;
  /** Called with the full reasoning text so far */
  onThinking?: (text: string) => void;
}

export function ask(options: AskOptions): Promise<AskResult> {
  ensureWebGlobals();
  return options.settings.preset.protocol === "anthropic"
    ? askAnthropic(options)
    : askOpenAICompatible(options);
}

// The plugin sandbox lacks some web APIs; borrow them from the main window
const WEB_GLOBALS = [
  "console",
  "fetch",
  "Headers",
  "Request",
  "Response",
  "ReadableStream",
  "TextDecoder",
  "TextEncoder",
  "AbortController",
  "AbortSignal",
  "URL",
  "URLSearchParams",
  "FormData",
  "Blob",
  "File",
  "DOMException",
  "setTimeout",
  "clearTimeout",
];

function mainWindow(): any {
  return hostWindow();
}

export function ensureWebGlobals() {
  const win = mainWindow();
  for (const name of WEB_GLOBALS) {
    const value = typeof win[name] === "function" && /^[a-z]/.test(name)
      ? win[name].bind(win)
      : win[name];
    for (const scope of [globalThis as any, _globalThis as any]) {
      if (typeof scope[name] === "undefined" && value) scope[name] = value;
    }
  }
}

function withSystemNote(system: string, note?: string) {
  return note ? `${system}\n\n${note}` : system;
}

// ---------------------------------------------------------------------------
// Anthropic: native citations over a custom content document whose blocks
// are sentences. Block i is selection[i] (or sentence i for the whole
// document), so citations map back to real sentence ids.

/**
 * Prompt cache lifetime. Writing costs 2× for an hour (1.25× for five
 * minutes) and reading about a twentieth: questions minutes apart about the
 * same document then cost little more than the first one
 */
const CACHE_TTL = "1h";

/** Models that accept server-side refusal fallbacks ("default" routing) */
const FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

/** Models that think adaptively and can share a summary of it */
function supportsAdaptiveThinking(model: string) {
  return /claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])/.test(model);
}

/** Track reasoning text and how long it lasted */
function thinkingTracker(onThinking?: (text: string) => void) {
  let text = "";
  let started = 0;
  let ended = 0;
  return {
    add(delta: string) {
      if (!started) started = Date.now();
      text += delta;
      onThinking?.(text);
    },
    end() {
      if (started && !ended) ended = Date.now();
    },
    result() {
      return text ? { thinking: text, thinkingMs: (ended || Date.now()) - started } : {};
    },
  };
}

/**
 * Local reasoning models often write their reasoning inline as
 * <think>…</think>; split it from the answer.
 */
export function splitThinkTags(raw: string): { answer: string; thinking: string } {
  const start = raw.indexOf("<think>");
  if (start === -1) return { answer: raw, thinking: "" };
  const end = raw.indexOf("</think>", start);
  if (end === -1) return { answer: raw.slice(0, start), thinking: raw.slice(start + 7) };
  const rest = splitThinkTags(raw.slice(end + 8));
  return {
    answer: (raw.slice(0, start) + rest.answer).replace(/^\s+/, ""),
    thinking: [raw.slice(start + 7, end).trim(), rest.thinking].filter(Boolean).join("\n\n"),
  };
}

export function anthropicClient(settings: AISettings) {
  ensureWebGlobals();
  const win = mainWindow();
  return new Anthropic({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    fetch: (input: any, init?: any) => win.fetch(input, init),
    // The plugin sandbox has no console of its own
    logger: win.console,
    dangerouslyAllowBrowser: true,
  });
}

/**
 * Ids for a cited block range of a (possibly partial) document. Blocks map
 * to global sentences; a range that spans a gap in the selection is split
 * into its contiguous runs.
 */
export function blocksToSpecs(
  doc: KonnashDocument,
  selection: number[] | undefined,
  startBlock: number,
  endBlock: number,
): string[] {
  if (!selection) {
    const spec = blockRangeToSpec(doc, startBlock, endBlock);
    return spec ? [spec] : [];
  }
  const globals = selection.slice(startBlock, Math.max(startBlock + 1, endBlock));
  const specs: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= globals.length; i++) {
    if (i === globals.length || globals[i] !== globals[i - 1] + 1) {
      const spec = blockRangeToSpec(doc, globals[runStart], globals[i - 1] + 1);
      if (spec) specs.push(spec);
      runStart = i;
    }
  }
  return specs;
}

async function askAnthropic(options: AskOptions): Promise<AskResult> {
  const { doc, title, source, history, question, settings, signal, onUpdate, selection } = options;
  const client = anthropicClient(settings);
  const sentences = selection ? selection.map((i) => doc.sentences[i]) : doc.sentences;

  const documentBlock: Record<string, unknown> = {
    type: "document",
    source: {
      type: "content",
      content: sentences.map((s) => ({ type: "text", text: s.text })),
    },
    title,
    citations: { enabled: true },
    // Metadata and outline: read by the model but never cited
    context: buildDocumentContext(doc, source, "native"),
    // The document is the stable prefix of every turn: cache it. Readers
    // ask, read for a while, then ask again; a five-minute cache would
    // expire between questions and be paid for again each time
    cache_control: { type: "ephemeral", ttl: CACHE_TTL },
  };
  const turns: ChatTurn[] = [...history, { role: "user", text: question }];
  const messages = turns.map((turn, i) => {
    if (i === 0) {
      return { role: "user", content: [documentBlock, { type: "text", text: turn.text }] };
    }
    return {
      role: turn.role,
      // Earlier answers without ids, so the model keeps using native citations
      content: turn.role === "assistant" ? stripMarkers(turn.text) : turn.text,
    };
  });

  const params: any = {
    model: settings.model,
    max_tokens: 32000,
    system: withSystemNote(getSystemPrompt("native"), options.partialNote),
    messages,
    // The conversation after the document is cached too (automatic
    // caching moves this mark to the newest turn), with the same lifetime:
    // a longer-lived entry must not follow a shorter one
    cache_control: { type: "ephemeral", ttl: CACHE_TTL },
  };
  if (settings.effort && supportsEffort(settings.model)) {
    params.output_config = { effort: settings.effort };
  }
  if (supportsAdaptiveThinking(settings.model)) {
    // Stream a readable summary of the model's reasoning (not the raw chain)
    params.thinking = { type: "adaptive", display: "summarized" };
  }
  if (FALLBACK_MODELS.has(settings.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const blocks = new Map<number, { text: string; specs: string[] }>();
  const compose = () =>
    [...blocks.keys()]
      .sort((a, b) => a - b)
      .map((k) => {
        const block = blocks.get(k)!;
        return block.specs.length
          ? `${block.text} [${[...new Set(block.specs)].join(", ")}]`
          : block.text;
      })
      .join("");

  const thinking = thinkingTracker(options.onThinking);
  try {
    const stream = client.beta.messages.stream(params, { signal });
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === "content_block_start" && event.content_block.type === "text") {
        thinking.end();
        blocks.set(event.index, { text: event.content_block.text || "", specs: [] });
      } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
        if (event.delta.thinking) thinking.add(event.delta.thinking);
      } else if (event.type === "content_block_delta") {
        const block = blocks.get(event.index);
        if (!block) continue;
        if (event.delta.type === "text_delta") {
          block.text += event.delta.text;
        } else if (event.delta.type === "citations_delta") {
          const c = event.delta.citation;
          if (c?.type === "content_block_location") {
            block.specs.push(...blocksToSpecs(doc, selection, c.start_block_index, c.end_block_index));
          }
        } else {
          continue;
        }
        onUpdate(compose());
      }
    }
    const final: any = await stream.finalMessage();
    const fallback = (final.content || []).find((b: any) => b.type === "fallback");
    thinking.end();
    const result: AskResult = {
      text: compose(),
      model: final.model,
      fallbackModel: fallback?.to?.model,
      truncated: final.stop_reason === "max_tokens",
      ...thinking.result(),
    };
    if (final.stop_reason === "refusal") {
      const category = final.stop_details?.category;
      result.refusal = category
        ? `The model declined to answer (${category}).`
        : "The model declined to answer.";
    }
    return result;
  } catch (e) {
    throw new Error(describeAnthropicError(e));
  }
}

export function describeAnthropicError(e: any): string {
  if (e instanceof Anthropic.APIUserAbortError) return "Stopped.";
  if (e instanceof Anthropic.AuthenticationError) {
    return "Anthropic rejected the API key. Check it in Konnash settings.";
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return `This API key can't use that model: ${e.message}`;
  }
  if (e instanceof Anthropic.NotFoundError) {
    return `Model not found: check the model in Konnash settings. (${e.message})`;
  }
  if (e instanceof Anthropic.RateLimitError) {
    return "Rate limited by Anthropic. Wait a moment and ask again.";
  }
  if (e instanceof Anthropic.BadRequestError) {
    return `Anthropic refused the request: ${e.message}`;
  }
  if (e instanceof Anthropic.APIError && e.status) {
    return `Anthropic error ${e.status}: ${e.message}`;
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return "Could not reach Anthropic. Check your internet connection.";
  }
  return String(e?.message || e);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions with Konnash's inline citation ids

export function openAIHeaders(settings: AISettings) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

export function endpoint(settings: AISettings, path: string) {
  return `${settings.baseURL.replace(/\/+$/, "")}/${path}`;
}

async function postOpenAI(settings: AISettings, body: unknown, signal?: AbortSignal) {
  const win = mainWindow();
  let response: any;
  try {
    response = await win.fetch(endpoint(settings, "chat/completions"), {
      method: "POST",
      headers: openAIHeaders(settings),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("Stopped.");
    throw new Error(`Could not reach ${settings.baseURL}: ${e?.message || e}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    const error: any = new Error(
      response.status === 401 || response.status === 403
        ? `${settings.preset.label} rejected the API key (${response.status}). ${detail}`
        : `${settings.preset.label} error ${response.status}: ${detail}`,
    );
    error.status = response.status;
    throw error;
  }
  return response;
}

/**
 * The chosen effort, in the shape each provider documents: OpenRouter's
 * reasoning object, the reasoning_effort field elsewhere. Nothing when the
 * provider is left to decide
 */
export function effortParams(settings: Pick<AISettings, "effort" | "preset">): Record<string, unknown> {
  if (!settings.effort) return {};
  return settings.preset.id === "openrouter"
    ? { reasoning: { effort: settings.effort } }
    : { reasoning_effort: settings.effort };
}

async function askOpenAICompatible(options: AskOptions): Promise<AskResult> {
  const { doc, title, source, history, question, settings, signal, onUpdate, selection } = options;
  const win = mainWindow();
  const system = withSystemNote(
    `${getSystemPrompt("protocol")}\n\n${buildDocumentContext(doc, source, "protocol")}`,
    options.partialNote,
  );
  const documentText = `<document title="${title.replace(/"/g, "'")}">\n${toNumberedText(doc, selection)}\n</document>`;
  const response = await postOpenAI(
    settings,
    {
      model: settings.model,
      stream: true,
      messages: [
        { role: "system", content: `${system}\n\n${documentText}` },
        ...history.map((t) => ({ role: t.role, content: t.text })),
        { role: "user", content: question },
      ],
      ...effortParams(settings),
    },
    signal,
  );

  let raw = "";
  let text = "";
  let model = settings.model;
  let finishReason = "";
  const thinking = thinkingTracker(options.onThinking);
  let reasoningField = "";
  const reader = response.body.getReader();
  const decoder = new win.TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.error) {
          throw new Error(`${settings.preset.label}: ${chunk.error.message || JSON.stringify(chunk.error)}`);
        }
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        // Reasoning, when the provider shares it as a separate field
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        const reasoningText = typeof reasoning === "string" ? reasoning : reasoning?.content;
        if (typeof reasoningText === "string" && reasoningText) {
          reasoningField += reasoningText;
          thinking.add(reasoningText);
        }
        const delta = choice?.delta?.content;
        if (delta) {
          raw += delta;
          const split = splitThinkTags(raw);
          if (split.thinking && !reasoningField) {
            const added = split.thinking.slice(thinking.result().thinking?.length || 0);
            if (added) thinking.add(added);
          }
          if (split.answer && split.answer !== text) {
            thinking.end();
            text = split.answer;
            onUpdate(text);
          }
        }
      }
    }
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("Stopped.");
    throw e;
  }
  thinking.end();
  return { text, model, truncated: finishReason === "length", ...thinking.result() };
}

// ---------------------------------------------------------------------------
// Structured helper calls (section summaries, ranking) on the helper model

/** Parse JSON from model text, tolerating ```json fences and stray prose */
export function parseJSONText(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("The helper model did not return valid JSON");
  }
}

export async function askJSON(
  settings: AISettings,
  system: string,
  user: string,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const model = settings.helperModel || settings.model;
  if (settings.preset.protocol === "anthropic") {
    const client = anthropicClient(settings);
    try {
      const params: any = {
        model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema } },
      };
      if (supportsEffort(model)) params.output_config.effort = "low";
      const message: any = await client.messages.create(params, { signal });
      if (message.stop_reason === "refusal") throw new Error("The helper model declined");
      const text = (message.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      return parseJSONText(text);
    } catch (e) {
      throw new Error(describeAnthropicError(e));
    }
  }
  const body: any = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "result", schema, strict: true } },
  };
  let response: any;
  try {
    response = await postOpenAI(settings, body, signal);
  } catch (e: any) {
    // Some endpoints don't support json_schema; ask in words instead
    if (e?.status !== 400) throw e;
    delete body.response_format;
    body.messages[0].content += "\n\nReply with JSON only, matching this schema:\n" + JSON.stringify(schema);
    response = await postOpenAI(settings, body, signal);
  }
  const data = await response.json();
  return parseJSONText(String(data?.choices?.[0]?.message?.content || ""));
}
