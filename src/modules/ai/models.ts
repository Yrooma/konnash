/**
 * Model lists from the provider itself, cached in prefs.
 *
 * - Anthropic: the Models API (id, display name, context window)
 * - OpenAI-compatible: GET {endpoint}/models (ids only)
 */
import { getPref, setPref } from "../../utils/prefs";
import { anthropicClient, describeAnthropicError, endpoint, ensureWebGlobals, openAIHeaders } from "./client";
import type { AISettings } from "./providers";
import { hostWindow } from "../../utils/window";

export interface ModelEntry {
  id: string;
  name: string;
  /** Input tokens, when the provider says */
  contextWindow?: number;
}

interface CacheEntry {
  fetchedAt: number;
  models: ModelEntry[];
}

const DAY = 24 * 60 * 60 * 1000;

function cacheKey(providerID: string, baseURL: string) {
  return `${providerID}|${baseURL.replace(/\/+$/, "")}`;
}

function readCache(): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(String(getPref("modelCache") || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** "200k context", "1M context": the same words in settings and in the panel */
export function formatContext(tokens?: number) {
  if (!tokens) return "";
  return tokens >= 1000000 ? `${Math.round(tokens / 100000) / 10}M context` : `${Math.round(tokens / 1000)}k context`;
}

export function getCachedModels(providerID: string, baseURL: string): CacheEntry | null {
  return readCache()[cacheKey(providerID, baseURL)] || null;
}

export function findCachedModel(providerID: string, baseURL: string, id: string) {
  return getCachedModels(providerID, baseURL)?.models.find((m) => m.id === id) || null;
}

export function isCacheStale(providerID: string, baseURL: string) {
  const entry = getCachedModels(providerID, baseURL);
  return !entry || Date.now() - entry.fetchedAt > DAY;
}

/** Normalise an Anthropic Models API page or an OpenAI-style /models body */
export function parseModelList(data: any): ModelEntry[] {
  const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return list
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({
      id: m.id,
      name: typeof m.display_name === "string" ? m.display_name : m.id,
      contextWindow: Number(m.max_input_tokens || m.context_length || m.context_window) || undefined,
    }));
}

export async function fetchModels(settings: AISettings): Promise<ModelEntry[]> {
  ensureWebGlobals();
  let models: ModelEntry[];
  if (settings.preset.protocol === "anthropic") {
    const client = anthropicClient(settings);
    const all: any[] = [];
    try {
      for await (const model of client.models.list({ limit: 100 } as any)) all.push(model);
    } catch (e) {
      throw new Error(describeAnthropicError(e));
    }
    models = parseModelList(all);
  } else {
    const win = hostWindow();
    const response = await win.fetch(endpoint(settings, "models"), { headers: openAIHeaders(settings) });
    if (!response.ok) {
      throw new Error(`${settings.preset.label} error ${response.status} while listing models`);
    }
    models = parseModelList(await response.json());
    models.sort((a, b) => a.id.localeCompare(b.id));
  }
  const cache = readCache();
  cache[cacheKey(settings.preset.id, settings.baseURL)] = { fetchedAt: Date.now(), models };
  setPref("modelCache", JSON.stringify(cache));
  return models;
}
