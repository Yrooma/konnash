/**
 * Everything Konnash keeps about one PDF, on this computer only:
 *   <Zotero data directory>/konnash/docs/<libraryID>_<attachmentKey>.json
 *
 * - chats: conversations. A user turn may be about one passage (`passage`),
 *   shown as a quoted reply; answers are stored as marker text
 * - trash: deleted conversations, restorable for 30 days
 * - sectionSummaries / rankings / sectionStats: the section map used to
 *   route questions (router.ts)
 *
 * Not synced and not part of Zotero's own backup. Safety net: atomic
 * writes, and a daily copy of each file in konnash/backups/ (14 days).
 * Versions 1–3 are migrated on load (v3 passage threads become chats).
 */
import { hostWindow } from "../utils/window";

export interface RoutingSection {
  id: string;
  /** The section's name on screen (sectionLabel) */
  title: string;
  /** The document gives this section no heading: `title` is Konnash's description */
  untitled?: boolean;
  pages: string;
  score: number;
  reason?: string;
}

export interface Routing {
  mode: "full" | "rules" | "focus" | "large";
  /** Rules: which metadata question was recognised */
  intent?: string;
  /** Sections sent (rules, focus, large), with Focus scores and reasons */
  sections?: RoutingSection[];
  totalSections?: number;
  /** Focus asked for, but the question concerns the whole document */
  global?: boolean;
  helperModel?: string;
  /** Time spent choosing sections */
  ms?: number;
}

export interface ParagraphAnchor {
  /** Paragraph index and id when the passage was saved */
  paragraph: number;
  pid: string;
  /** First characters and length of the paragraph text, to find it again */
  start: string;
  length: number;
}

export interface StoredPassageRef {
  anchor: ParagraphAnchor;
  /** Global sentence range [first, last] when part of a paragraph */
  sentences?: [number, number];
}

export interface StoredMessage {
  role: "user" | "assistant";
  /** User: the question or instruction as sent. Assistant: marker text */
  text: string;
  /** User: the suggestion used ("Explain"), shown instead of its long text */
  label?: string;
  /** User: the passage this question is about */
  passage?: StoredPassageRef;
  /** Footer details for answers (model, checks) */
  meta?: string[];
  error?: string;
  routing?: Routing;
  /** The model's reasoning summary, and how long it thought */
  thinking?: string;
  thinkingMs?: number;
  /** Answer: the reader's chosen direction (absent: per paragraph) */
  dir?: "rtl" | "ltr";
  time: number;
}

export interface StoredChat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: StoredMessage[];
}

export interface TrashItem {
  kind: "chat";
  deletedAt: number;
  chat: StoredChat;
}

export interface SectionSummary {
  id: string;
  summary: string;
  terms: string[];
}

export interface DocFile {
  version: 4;
  /**
   * The document's fingerprint (router.ts documentBasis): the same PDF has
   * the same one on any computer, whatever key Zotero gave it there
   */
  basis?: string;
  chats: StoredChat[];
  trash: TrashItem[];
  /** Built once per document version by the helper model */
  sectionSummaries?: { basis: string; model: string; at: number; items: SectionSummary[] };
  /** Focus rankings by normalised question */
  rankings: Record<string, { basis: string; global: boolean; sections: { id: string; score: number; reason?: string }[]; at: number }>;
  /** How often each section was routed to */
  sectionStats: Record<string, number>;
}

export const TRASH_DAYS = 30;

export function emptyDocFile(): DocFile {
  return { version: 4, chats: [], trash: [], rankings: {}, sectionStats: {} };
}

export function newID(now = Date.now()) {
  return `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newChat(now = Date.now()): StoredChat {
  return { id: newID(now), title: "New chat", created: now, updated: now, messages: [] };
}

export function chatTitleFrom(question: string) {
  const oneLine = question.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Parsing (tolerant: keeps whatever is valid in a damaged file)

const str = (v: any) => (typeof v === "string" ? v : undefined);
const num = (v: any) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : undefined);
const strings = (v: any) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);

function parseRouting(v: any): Routing | undefined {
  if (!v || !["full", "rules", "focus", "large"].includes(v.mode)) return undefined;
  const sections = Array.isArray(v.sections)
    ? v.sections
        .filter((s: any) => typeof s?.id === "string")
        .map((s: any) => ({ id: s.id, title: str(s.title) ?? s.id, untitled: s.untitled === true || undefined, pages: str(s.pages) ?? "", score: num(s.score) ?? 0, reason: str(s.reason) }))
    : // v2 stored only ids
      strings(v.sectionIds)?.map((id) => ({ id, title: id, pages: "", score: 0 }));
  return {
    mode: v.mode,
    intent: str(v.intent),
    sections,
    totalSections: num(v.totalSections),
    global: v.global === true ? true : undefined,
    helperModel: str(v.helperModel),
    ms: num(v.ms),
  };
}

function parseAnchor(a: any): ParagraphAnchor | null {
  if (!a || !Number.isInteger(a.paragraph)) return null;
  return { paragraph: a.paragraph, pid: str(a.pid) ?? "", start: str(a.start) ?? "", length: num(a.length) ?? 0 };
}

function parseSentences(v: any): [number, number] | undefined {
  return Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) ? (v as [number, number]) : undefined;
}

function parsePassageRef(v: any): StoredPassageRef | undefined {
  const anchor = parseAnchor(v?.anchor);
  return anchor ? { anchor, sentences: parseSentences(v.sentences) } : undefined;
}

function parseMessage(m: any): StoredMessage {
  return {
    role: m.role,
    text: m.text,
    label: str(m.label),
    passage: parsePassageRef(m.passage),
    meta: strings(m.meta),
    error: str(m.error),
    routing: parseRouting(m.routing),
    thinking: str(m.thinking),
    thinkingMs: num(m.thinkingMs),
    dir: m.dir === "rtl" || m.dir === "ltr" ? m.dir : undefined,
    time: num(m.time) ?? 0,
  };
}

function parseChat(chat: any): StoredChat | null {
  if (typeof chat?.id !== "string" || !Array.isArray(chat.messages)) return null;
  return {
    id: chat.id,
    title: str(chat.title) ?? "Chat",
    created: num(chat.created) ?? 0,
    updated: num(chat.updated) ?? 0,
    messages: chat.messages
      .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.text === "string")
      .map(parseMessage),
  };
}

/** A v3 passage thread (or v2 explanation) as a conversation */
function chatFromPassage(p: any): StoredChat | null {
  const ref = parsePassageRef(p);
  if (typeof p?.id !== "string" || !ref) return null;
  const turns: any[] = Array.isArray(p.turns)
    ? p.turns
    : typeof p.text === "string"
      ? [{ question: "Explain", label: "Explain", text: p.text, meta: p.meta, error: p.error, created: p.created }]
      : [];
  const messages: StoredMessage[] = [];
  for (const t of turns) {
    if (typeof t?.text !== "string") continue;
    const time = num(t.created) ?? 0;
    messages.push({ role: "user", text: str(t.question) || str(t.label) || "Explain", label: str(t.label), passage: ref, time });
    messages.push({
      role: "assistant",
      text: t.text,
      meta: strings(t.meta),
      error: str(t.error),
      routing: parseRouting(t.routing),
      thinking: str(t.thinking),
      thinkingMs: num(t.thinkingMs),
      time,
    });
  }
  if (!messages.length) return null;
  const created = num(p.created) ?? messages[0].time;
  return {
    id: p.id,
    title: `Passage · ${ref.anchor.pid}`,
    created,
    updated: num(p.updated) ?? created,
    messages,
  };
}

export function parseDocFile(json: string): DocFile {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return emptyDocFile();
  }
  const file = emptyDocFile();
  if (typeof data?.basis === "string") file.basis = data.basis;
  file.chats = [
    ...(Array.isArray(data?.chats) ? data.chats : []).map(parseChat),
    ...(Array.isArray(data?.passages) ? data.passages : []).map(chatFromPassage),
    ...(Array.isArray(data?.explanations) ? data.explanations : []).map(chatFromPassage),
  ].filter(Boolean) as StoredChat[];
  for (const t of Array.isArray(data?.trash) ? data.trash : []) {
    const deletedAt = num(t?.deletedAt);
    if (!deletedAt) continue;
    const chat = t.kind === "passage" ? chatFromPassage(t.passage) : parseChat(t.chat);
    if (chat) file.trash.push({ kind: "chat", deletedAt, chat });
  }
  const s = data?.sectionSummaries;
  if (s && typeof s.basis === "string" && Array.isArray(s.items)) {
    file.sectionSummaries = {
      basis: s.basis,
      model: str(s.model) ?? "",
      at: num(s.at) ?? 0,
      items: s.items
        .filter((x: any) => typeof x?.id === "string")
        .map((x: any) => ({ id: x.id, summary: str(x.summary) ?? "", terms: strings(x.terms) ?? [] })),
    };
  }
  if (data?.rankings && typeof data.rankings === "object") {
    for (const [key, r] of Object.entries<any>(data.rankings)) {
      if (!r || typeof r.basis !== "string") continue;
      const sections = Array.isArray(r.sections)
        ? r.sections.filter((x: any) => typeof x?.id === "string").map((x: any) => ({ id: x.id, score: num(x.score) ?? 0, reason: str(x.reason) }))
        : (strings(r.sectionIds) ?? []).map((id) => ({ id, score: 3 }));
      file.rankings[key] = { basis: r.basis, global: !!r.global, sections, at: num(r.at) ?? 0 };
    }
  }
  if (data?.sectionStats && typeof data.sectionStats === "object") {
    for (const [key, n] of Object.entries<any>(data.sectionStats)) {
      if (Number.isFinite(n)) file.sectionStats[key] = n;
    }
  }
  return file;
}

// ---------------------------------------------------------------------------
// Bringing conversations from another computer

/** The fingerprint of the document a file belongs to, if it says */
export function fileBasis(file: DocFile) {
  return file.basis || file.sectionSummaries?.basis || Object.values(file.rankings)[0]?.basis || null;
}

/**
 * Merge another computer's file for the same document into `target`
 * (in place). Nothing is lost: conversations are joined by id (the newer
 * copy wins when both have one), one deleted here stays deleted, summaries
 * and rankings keep the newer, section counts add up.
 */
export function mergeDocFiles(target: DocFile, incoming: DocFile) {
  let added = 0;
  let updated = 0;
  const trashed = new Set(target.trash.map((t) => t.chat.id));
  for (const chat of incoming.chats) {
    if (!chat.messages.length || trashed.has(chat.id)) continue;
    const i = target.chats.findIndex((c) => c.id === chat.id);
    if (i < 0) {
      target.chats.push(chat);
      added++;
    } else if (chat.updated > target.chats[i].updated) {
      target.chats[i] = chat;
      updated++;
    }
  }
  const active = new Set(target.chats.map((c) => c.id));
  for (const item of incoming.trash) {
    if (!active.has(item.chat.id) && !trashed.has(item.chat.id)) target.trash.push(item);
  }
  const s = incoming.sectionSummaries;
  if (s && (!target.sectionSummaries || (s.basis === target.sectionSummaries.basis && s.at > target.sectionSummaries.at))) {
    target.sectionSummaries = s;
  }
  for (const [key, r] of Object.entries(incoming.rankings)) {
    if (!target.rankings[key] || r.at > target.rankings[key].at) target.rankings[key] = r;
  }
  for (const [key, n] of Object.entries(incoming.sectionStats)) {
    target.sectionStats[key] = (target.sectionStats[key] || 0) + n;
  }
  target.basis ||= incoming.basis;
  target.chats.sort((a, b) => b.updated - a.updated);
  return { added, updated };
}

export function serializeDocFile(file: DocFile) {
  return JSON.stringify({ ...file, version: 4, chats: file.chats.filter((c) => c.messages.length) }, null, 1);
}

// ---------------------------------------------------------------------------
// Trash

export function trashChat(file: DocFile, chat: StoredChat, now = Date.now()) {
  file.chats = file.chats.filter((c) => c !== chat);
  if (chat.messages.length) file.trash.unshift({ kind: "chat", deletedAt: now, chat });
}

export function restoreFromTrash(file: DocFile, item: TrashItem) {
  file.trash = file.trash.filter((t) => t !== item);
  file.chats.unshift(item.chat);
}

export function deleteForever(file: DocFile, item: TrashItem) {
  file.trash = file.trash.filter((t) => t !== item);
}

/** Drop trash older than TRASH_DAYS; returns whether anything changed */
export function purgeTrash(file: DocFile, now = Date.now()) {
  const before = file.trash.length;
  file.trash = file.trash.filter((t) => now - t.deletedAt < TRASH_DAYS * 86400000);
  return file.trash.length !== before;
}

// ---------------------------------------------------------------------------
// Disk

const BACKUP_DAYS = 14;
const cache = new Map<string, Promise<DocFile>>();

function io() {
  const win = hostWindow();
  return { PathUtils: win.PathUtils, IOUtils: win.IOUtils };
}

export function getDataDir() {
  return io().PathUtils.join(Zotero.DataDirectory.dir, "konnash");
}

function paths(attachment: Zotero.Item) {
  const { PathUtils } = io();
  const base = getDataDir();
  const name = `${attachment.libraryID}_${attachment.key}.json`;
  return {
    name,
    dir: PathUtils.join(base, "docs"),
    file: PathUtils.join(base, "docs", name),
    legacy: PathUtils.join(base, "chats", name),
    backups: PathUtils.join(base, "backups"),
  };
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function loadDoc(attachment: Zotero.Item): Promise<DocFile> {
  const key = `${attachment.libraryID}_${attachment.key}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = (async () => {
      const { IOUtils } = io();
      const { file, legacy } = paths(attachment);
      for (const path of [file, legacy]) {
        if (await IOUtils.exists(path)) {
          const parsed = parseDocFile(await IOUtils.readUTF8(path));
          purgeTrash(parsed);
          return parsed;
        }
      }
      return emptyDocFile();
    })().catch((e) => {
      ztoolkit.log("Konnash: could not load saved data", e);
      return emptyDocFile();
    });
    cache.set(key, promise);
  }
  return promise;
}

async function writeDoc(attachment: Zotero.Item, file: DocFile) {
  const { IOUtils, PathUtils } = io();
  const { dir, file: path, name, backups } = paths(attachment);
  await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
  // Keep the day's first version before overwriting it
  if (await IOUtils.exists(path)) {
    const dayDir = PathUtils.join(backups, today());
    const backup = PathUtils.join(dayDir, name);
    if (!(await IOUtils.exists(backup))) {
      await IOUtils.makeDirectory(dayDir, { createAncestors: true, ignoreExisting: true });
      await IOUtils.copy(path, backup);
    }
  }
  // Written to a temporary file first, so a crash can't leave half a file
  await IOUtils.writeUTF8(path, serializeDocFile(file), { tmpPath: `${path}.tmp` });
}

/** Save at once (an import), rather than after the usual short delay */
export function saveDocNow(attachment: Zotero.Item, file: DocFile) {
  return writeDoc(attachment, file);
}

/** Save, coalescing rapid successive saves of the same file */
const pending = new Map<string, any>();
export function saveDoc(attachment: Zotero.Item, file: DocFile) {
  const key = `${attachment.libraryID}_${attachment.key}`;
  const win = hostWindow();
  if (pending.has(key)) win.clearTimeout(pending.get(key));
  pending.set(
    key,
    win.setTimeout(() => {
      pending.delete(key);
      writeDoc(attachment, file).catch((e) => ztoolkit.log("Konnash: could not save", e));
    }, 300),
  );
}

/** Remove backup days older than BACKUP_DAYS (folders are named YYYY-MM-DD) */
export async function pruneBackups() {
  try {
    const { IOUtils, PathUtils } = io();
    const dir = PathUtils.join(getDataDir(), "backups");
    if (!(await IOUtils.exists(dir))) return;
    const cutoff = new Date(Date.now() - BACKUP_DAYS * 86400000).toISOString().slice(0, 10);
    for (const child of await IOUtils.getChildren(dir)) {
      const day = PathUtils.filename(child);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
        await IOUtils.remove(child, { recursive: true, ignoreAbsent: true });
      }
    }
  } catch (e) {
    ztoolkit.log("Konnash: could not prune backups", e);
  }
}

export function clearDocStoreCache() {
  cache.clear();
}
