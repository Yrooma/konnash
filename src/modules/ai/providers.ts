/**
 * AI providers Konnash can talk to, and how each one cites.
 *
 * - native:   the provider's API attaches citations itself (Anthropic)
 * - protocol: Konnash's method, inline [S12] ids (every other provider)
 * - basic:    the same method, on a model running on this computer
 *
 * Every answer's citations are checked the same way, whatever the method.
 * Konnash favours no provider and suggests no model: nothing is chosen
 * until the reader chooses it, and models come from the provider's own
 * list (models.ts).
 */
import { getPref, setPref } from "../../utils/prefs";
import { findCachedModel } from "./models";

export type CitationTier = "native" | "protocol" | "basic";
export type Protocol = "anthropic" | "openai";

export interface ProviderPreset {
  id: string;
  label: string;
  protocol: Protocol;
  tier: CitationTier;
  baseURL: string;
  /** Context window assumed when the model list doesn't say */
  assumedContext: number;
  needsKey: boolean;
}

/** Hosted providers in alphabetical order, then local ones, then any other */
export const PROVIDERS: ProviderPreset[] = [
  { id: "anthropic", label: "Anthropic", protocol: "anthropic", tier: "native", baseURL: "https://api.anthropic.com", assumedContext: 200000, needsKey: true },
  { id: "deepseek", label: "DeepSeek", protocol: "openai", tier: "protocol", baseURL: "https://api.deepseek.com/v1", assumedContext: 64000, needsKey: true },
  { id: "gemini", label: "Google Gemini", protocol: "openai", tier: "protocol", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", assumedContext: 128000, needsKey: true },
  { id: "openai", label: "OpenAI", protocol: "openai", tier: "protocol", baseURL: "https://api.openai.com/v1", assumedContext: 128000, needsKey: true },
  { id: "openrouter", label: "OpenRouter", protocol: "openai", tier: "protocol", baseURL: "https://openrouter.ai/api/v1", assumedContext: 128000, needsKey: true },
  { id: "lmstudio", label: "LM Studio (local)", protocol: "openai", tier: "basic", baseURL: "http://localhost:1234/v1", assumedContext: 16000, needsKey: false },
  { id: "ollama", label: "Ollama (local)", protocol: "openai", tier: "basic", baseURL: "http://localhost:11434/v1", assumedContext: 16000, needsKey: false },
  { id: "custom", label: "Other OpenAI-compatible", protocol: "openai", tier: "protocol", baseURL: "", assumedContext: 32000, needsKey: false },
];

/** Before the reader chooses a provider: nothing to talk to yet */
const NO_PROVIDER: ProviderPreset = {
  id: "",
  label: "No provider",
  protocol: "openai",
  tier: "protocol",
  baseURL: "",
  assumedContext: 32000,
  needsKey: false,
};

/** How the provider cites: a description, not a ranking */
export const TIER_LABELS: Record<CitationTier, string> = {
  native: "Citations attached by the provider's API",
  protocol: "Citations by sentence number",
  basic: "Citations by sentence number, on this computer",
};

// Effort ------------------------------------------------------------------------------
// How much the model thinks before answering, where the provider documents
// it. Anthropic keeps the setting it always had (Settings → Konnash); for
// the others, unset means the provider's own default, and nothing is sent.

export interface EffortLevel {
  value: string;
  label: string;
}
const LOW = { value: "low", label: "Low" };
const MEDIUM = { value: "medium", label: "Medium" };
const HIGH = { value: "high", label: "High" };
const EFFORT_LEVELS: Record<string, EffortLevel[]> = {
  anthropic: [LOW, MEDIUM, HIGH, { value: "xhigh", label: "Extra high" }, { value: "max", label: "Max" }],
  // DeepSeek V4: low, high and max (its default is high)
  deepseek: [LOW, HIGH, { value: "max", label: "Max" }],
  gemini: [LOW, MEDIUM, HIGH],
  openai: [LOW, MEDIUM, HIGH],
  openrouter: [LOW, MEDIUM, HIGH],
};

/** Anthropic models that take an effort level */
export function supportsEffort(model: string) {
  return !/haiku-4|claude-3/.test(model);
}

/** The levels offered for this provider and model; none when it has no such setting */
export function effortLevels(preset: ProviderPreset, model: string): EffortLevel[] {
  if (preset.id === "anthropic" && !supportsEffort(model)) return [];
  return EFFORT_LEVELS[preset.id] || [];
}

function providerEfforts(): Record<string, string> {
  try {
    const parsed = JSON.parse(String(getPref("providerEffort") || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The level chosen for this provider and model ("" for the provider's default) */
function chosenEffort(preset: ProviderPreset, model: string) {
  const value = preset.id === "anthropic" ? String(getPref("effort") || "medium") : providerEfforts()[preset.id] || "";
  return effortLevels(preset, model).some((l) => l.value === value) ? value : "";
}

/** Choose a level ("" for the provider's default; Anthropic always has one) */
export function setEffort(preset: ProviderPreset, value: string) {
  if (preset.id === "anthropic") {
    setPref("effort", value || "medium");
    return;
  }
  const all = providerEfforts();
  if (value) all[preset.id] = value;
  else delete all[preset.id];
  setPref("providerEffort", JSON.stringify(all));
}

export interface AISettings {
  preset: ProviderPreset;
  baseURL: string;
  model: string;
  /** Model for small background jobs (section summaries, ranking) */
  helperModel: string;
  apiKey: string;
  /** The effort level to send, or "" to send none (the provider decides) */
  effort: string;
  /** Input tokens the main model accepts */
  contextWindow: number;
}

/**
 * Earlier versions made Anthropic the default provider, so a reader who
 * set Konnash up with an Anthropic key never had to choose it. Keep their
 * setup working now that nothing is chosen for them.
 */
export function keepEarlierProviderChoice() {
  if (String(getPref("provider") || "")) return;
  const key = String(getPref("apiKey") || "").trim();
  const model = String(getPref("model") || "").trim();
  if (key.startsWith("sk-ant-") || model.startsWith("claude-")) setPref("provider", "anthropic");
}

/** The provider with this id, or none at all (never a default) */
export function getPreset(id: string) {
  return PROVIDERS.find((p) => p.id === id) || NO_PROVIDER;
}

export function getSettings(): AISettings {
  const preset = getPreset(String(getPref("provider") || ""));
  const baseURL = String(getPref("baseURL") || "").trim() || preset.baseURL;
  const model = String(getPref("model") || "").trim();
  const helperPref = String(getPref("helperModel") || "").trim();
  return {
    preset,
    baseURL,
    model,
    // Unset (or "same"): the main model does the helper's jobs too
    helperModel: helperPref && helperPref !== "same" ? helperPref : model,
    apiKey: String(getPref("apiKey") || "").trim(),
    effort: chosenEffort(preset, model),
    contextWindow: findCachedModel(preset.id, baseURL, model)?.contextWindow || preset.assumedContext,
  };
}

/** Why the current settings can't be used yet, or null when ready */
export function getSettingsProblem(settings: AISettings): string | null {
  if (!settings.preset.id) return "Choose an AI provider in Konnash settings.";
  if (!settings.baseURL) return "Set the endpoint URL in Konnash settings.";
  if (!settings.model) return "Choose a model in Konnash settings (Refresh loads your provider's list).";
  if (settings.preset.needsKey && !settings.apiKey) {
    return `Add your ${settings.preset.label} API key in Konnash settings.`;
  }
  return null;
}
