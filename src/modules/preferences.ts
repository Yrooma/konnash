/**
 * Konnash settings pane (Zotero Settings → Konnash): provider, API key,
 * model and helper model (from the provider's own list), endpoint, effort.
 */
import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { hostWindow } from "../utils/window";
import { getPreset, getSettings, TIER_LABELS } from "./ai/providers";
import { fetchModels, formatContext, getCachedModels, isCacheStale } from "./ai/models";
import {
  addDocumentPrompt,
  editPrompt,
  getOverrides,
  getPrompts,
  PromptSet,
  removePrompt,
  resetAllPrompts,
  resetPrompt,
  resolvePassageDefault,
  setPassageDefault,
  showPrompt,
} from "./prompts";
import prefsCSS from "../../addon/content/prefs.css";
import { getDataDir } from "./docStore";
import { importConversations } from "./transfer";

let paneID: string | null = null;

export async function registerPreferences() {
  paneID = await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: "Konnash",
    // Fixed colours: the settings sidebar doesn't give icons a context fill
    image: `chrome://${config.addonRef}/content/icons/konnash-settings.svg`,
  });
}

export function openSettings() {
  (Zotero.Utilities.Internal as any).openPreferences(paneID || undefined);
}

// How each kind of provider cites. A description, not a ranking: every
// answer's citations are checked the same way, whichever provider wrote it
const TIER_HELP = {
  native:
    "The provider's API links each part of the answer to the sentences it rests on. Konnash checks every citation and marks statements without one.",
  protocol:
    "Konnash numbers every sentence and the model cites the numbers. Konnash checks every citation and marks statements without one.",
  basic:
    "Konnash numbers every sentence and the model, running on this computer, cites the numbers. Konnash checks every citation and marks statements without one.",
};

const CUSTOM = "__custom";
const SAME = "same";

function contextLabel(tokens?: number) {
  return tokens ? ` · ${formatContext(tokens)}` : "";
}

export function onPrefsLoad(win: Window) {
  const doc = win.document;
  const id = (name: string) => doc.getElementById(`zotero-prefpane-${config.addonRef}-${name}`) as any;
  const provider = id("provider");
  if (!provider) return;
  const modelSelect = id("model-select") as HTMLSelectElement;
  const helperSelect = id("helper-select") as HTMLSelectElement;
  const customRow = id("model-custom-row");
  const customInput = id("model-custom") as HTMLInputElement;
  const status = id("models-status");
  const defaultStatus = status.textContent;

  const option = (value: string, label: string) => {
    const o = doc.createElementNS("http://www.w3.org/1999/xhtml", "option") as HTMLOptionElement;
    o.value = value;
    o.textContent = label;
    return o;
  };

  const populate = () => {
    const settings = getSettings();
    const preset = settings.preset;
    const cached = getCachedModels(preset.id, settings.baseURL)?.models || [];
    const current = String(getPref("model") || "");

    // Nothing is chosen for the reader: no model until they pick one
    modelSelect.replaceChildren();
    if (!current) {
      modelSelect.append(option("", cached.length ? "Choose a model…" : "Press Refresh to load your models"));
    }
    for (const m of cached) {
      modelSelect.append(option(m.id, `${m.name}${m.name !== m.id ? ` (${m.id})` : ""}${contextLabel(m.contextWindow)}`));
    }
    const known = cached.some((m) => m.id === current);
    if (current && !known) modelSelect.append(option(current, current));
    modelSelect.append(option(CUSTOM, "Other…"));
    modelSelect.value = current;
    customRow.hidden = true;

    helperSelect.replaceChildren(option(SAME, "Same as main model"));
    for (const m of cached) helperSelect.append(option(m.id, m.name));
    const helperPref = String(getPref("helperModel") || "");
    if (helperPref && helperPref !== SAME && !cached.some((m) => m.id === helperPref)) {
      helperSelect.append(option(helperPref, helperPref));
    }
    helperSelect.value = helperPref || SAME;

    id("baseURL").placeholder = preset.baseURL || "https://your-endpoint/v1";
    id("apiKey").placeholder = preset.needsKey ? "required" : "not needed for local models";
    id("tier").textContent = preset.id
      ? `${TIER_LABELS[preset.tier]}: ${TIER_HELP[preset.tier]}`
      : "Choose the provider whose account you use. Konnash works the same way with each.";
    id("effort-row").hidden = preset.protocol !== "anthropic";
  };

  const refresh = async (quiet = false) => {
    const settings = getSettings();
    if (!settings.preset.id) {
      if (!quiet) status.textContent = "Choose a provider first.";
      return;
    }
    if (settings.preset.needsKey && !settings.apiKey) {
      if (!quiet) status.textContent = "Add your API key first, then press Refresh.";
      return;
    }
    status.textContent = "Loading models…";
    try {
      const models = await fetchModels(settings);
      populate();
      status.textContent = `Loaded ${models.length} models from ${settings.preset.label}.`;
    } catch (e: any) {
      status.textContent = `Could not load models: ${e?.message || e}`;
    }
  };

  modelSelect.addEventListener("change", () => {
    if (modelSelect.value === CUSTOM) {
      customRow.hidden = false;
      customInput.value = String(getPref("model") || "");
      customInput.focus();
    } else {
      customRow.hidden = true;
      setPref("model", modelSelect.value);
    }
  });
  customInput.addEventListener("change", () => setPref("model", customInput.value.trim()));
  helperSelect.addEventListener("change", () => setPref("helperModel", helperSelect.value));
  id("refresh").addEventListener("click", () => refresh());
  id("apiKey").addEventListener("change", () => win.setTimeout(() => refresh(true), 100));
  id("baseURL").addEventListener("change", () => win.setTimeout(() => {
    populate();
    refresh(true);
  }, 100));
  provider.addEventListener("command", () => {
    // Model names belong to a provider: start fresh with the new one
    setPref("model", "");
    setPref("helperModel", "");
    win.setTimeout(() => {
      status.textContent = defaultStatus;
      populate();
      const s = getSettings();
      if (isCacheStale(s.preset.id, s.baseURL)) refresh(true);
    }, 50);
  });

  populate();
  const s = getSettings();
  if (isCacheStale(getPreset(s.preset.id).id, s.baseURL)) refresh(true);

  injectStyles(doc);
  renderPromptEditor(doc, id("prompts"));
  setupDataSection(doc, id("data-path"), id("data-show"));
  setupImport(doc, id("import"), id("import-report"));
}

const HTML = "http://www.w3.org/1999/xhtml";

/** The pane's stylesheet, bundled (never a stale cached file) */
function injectStyles(doc: Document) {
  const pane = doc.querySelector(".konnash-prefs");
  if (!pane || pane.querySelector("#konnash-prefs-style")) return;
  const style = doc.createElementNS(HTML, "style") as HTMLStyleElement;
  style.id = "konnash-prefs-style";
  style.textContent = prefsCSS;
  pane.prepend(style);
}

/** Suggested prompts as a list: Edit · Hide/Show · Reset, inline editor */
function renderPromptEditor(doc: Document, container: HTMLElement | null) {
  if (!container) return;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = doc.createElementNS(HTML, tag) as HTMLElementTagNameMap[K];
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let editing: string | null = null;
  const link = (text: string, onClick: () => void) => {
    const b = el("button", "kp-link", text);
    b.addEventListener("click", onClick);
    return b;
  };
  const render = () => {
    container.replaceChildren();
    const passageDefault = resolvePassageDefault(getOverrides()).id;
    const group = (set: PromptSet, heading: string) => {
      container.append(el("div", "kp-group", heading));
      const list = el("div", "kp-prompts");
      for (const prompt of getPrompts(set, true)) {
        const key = `${set}:${prompt.id}`;
        const row = el("div", `kp-prompt${prompt.hidden ? " kp-hidden" : ""}`);
        const head = el("div", "kp-prompt-head");
        const labelEl = el("span", "kp-prompt-label", prompt.label);
        labelEl.dir = "auto";
        head.append(labelEl);
        if (prompt.hidden) head.append(el("span", "kp-badge kp-off", "Hidden"));
        else if (prompt.recommended) head.append(el("span", "kp-badge", "Recommended"));
        else head.append(el("span", "kp-badge kp-own", prompt.custom ? "Yours" : "Edited"));
        head.append(el("span", "kp-spacer"));
        if (set === "passage" && !prompt.hidden) {
          const choose = el("label", "kp-default");
          const radio = el("input");
          radio.type = "radio";
          radio.name = "konnash-passage-default";
          radio.checked = prompt.id === passageDefault;
          radio.addEventListener("change", () => setPassageDefault(prompt.id));
          choose.title = "Runs when you press Enter with a passage attached and nothing typed";
          choose.append(radio, doc.createTextNode("Enter runs this"));
          head.append(choose);
        }
        if (!prompt.hidden) head.append(link(editing === key ? "Close" : "Edit", () => {
          editing = editing === key ? null : key;
          render();
        }));
        if (prompt.hidden) {
          head.append(link("Show", () => {
            showPrompt(set, prompt.id);
            render();
          }));
        } else if (!(set === "passage" && prompt.id === passageDefault)) {
          head.append(link(prompt.custom ? "Delete" : "Hide", () => {
            removePrompt(set, prompt.id);
            render();
          }));
        }
        if (!prompt.recommended && !prompt.custom) {
          head.append(link("Reset", () => {
            resetPrompt(set, prompt.id);
            render();
          }));
        }
        row.append(head);
        if (editing === key) {
          const editor = el("div", "kp-editor");
          const label = el("input");
          label.value = prompt.label;
          label.placeholder = "Label";
          const text = el("textarea");
          text.value = prompt.text;
          label.dir = "auto";
          text.dir = "auto";
          const actions = el("div", "kp-editor-actions");
          const save = el("button", undefined, "Save");
          save.addEventListener("click", () => {
            editPrompt(set, prompt.id, { label: label.value.trim(), text: text.value.trim() });
            editing = null;
            render();
          });
          const cancel = el("button", undefined, "Cancel");
          cancel.addEventListener("click", () => {
            editing = null;
            render();
          });
          actions.append(save, cancel);
          editor.append(label, text, actions);
          row.append(editor);
        } else {
          const preview = el("div", "kp-prompt-preview", prompt.text.replace(/\s+/g, " "));
          preview.dir = "auto";
          row.append(preview);
        }
        list.append(row);
      }
      container.append(list);
    };
    group("document", "About the whole document");
    group("passage", "About a passage");
    const actions = el("div", "kp-list-actions");
    actions.append(
      link("+ Add a document suggestion", () => {
        addDocumentPrompt("My question", "Write your question or instruction here.");
        const added = getPrompts("document").at(-1);
        editing = added ? `document:${added.id}` : null;
        render();
      }),
      link("Reset all to recommended", () => {
        resetAllPrompts();
        editing = null;
        render();
      }),
    );
    container.append(actions);
  };
  render();
}

function setupDataSection(doc: Document, pathEl: HTMLElement | null, showButton: HTMLElement | null) {
  if (!pathEl || !showButton) return;
  const dir = getDataDir();
  pathEl.textContent = dir;
  showButton.addEventListener("click", async () => {
    try {
      await hostWindow().IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
      (Zotero.File as any).reveal(dir);
    } catch (e) {
      ztoolkit.log("Konnash: could not show folder", e);
    }
  });
}

/** Settings → Your data → From another computer */
function setupImport(doc: Document, button: HTMLButtonElement | null, report: HTMLElement | null) {
  if (!button || !report) return;
  const line = (text: string, className?: string) => {
    const p = doc.createElementNS(HTML, "div") as HTMLDivElement;
    if (className) p.className = className;
    p.textContent = text;
    return p;
  };
  button.addEventListener("click", async () => {
    const win = doc.defaultView as Window;
    const folder = await new ztoolkit.FilePicker("Choose the konnash folder from the other computer", "folder", undefined, undefined, win).open();
    if (!folder) return;
    button.disabled = true;
    report.hidden = false;
    report.replaceChildren(line("Matching conversations to the PDFs in this library…"));
    try {
      const { results, backup, empty } = await importConversations(folder, (text) => report.replaceChildren(line(text)));
      report.replaceChildren();
      if (empty) {
        report.append(line("No conversation files in this folder. Choose the konnash folder (or the docs folder inside it)."));
        return;
      }
      const added = results.reduce((n, r) => n + r.added, 0);
      const updated = results.reduce((n, r) => n + r.updated, 0);
      report.append(line(`Imported ${added} conversation${added === 1 ? "" : "s"}${updated ? `, updated ${updated}` : ""}.`, "kp-report-head"));
      for (const r of results) {
        report.append(
          r.skipped
            ? line(`Not imported, ${r.file}: ${r.skipped}.`, "kp-report-skip")
            : line(`${r.title || r.file}: ${r.added} new${r.updated ? `, ${r.updated} updated` : ""}${!r.added && !r.updated ? " (already here)" : ""}`),
        );
      }
      if (backup) report.append(line(`Your earlier files are kept in ${backup}`, "kp-report-note"));
    } catch (e: any) {
      report.replaceChildren(line(`Could not import: ${e?.message || e}`, "kp-report-skip"));
    } finally {
      button.disabled = false;
    }
  });
}
