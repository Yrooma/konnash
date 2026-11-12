/**
 * Bringing conversations from another computer (Settings → Konnash →
 * Your data → Import).
 *
 * Konnash names each document's file after its Zotero key
 * (<libraryID>_<key>.json). Without Zotero sync the same PDF has another
 * key on each computer, so a file is matched by the document's
 * fingerprint (router.ts documentBasis: paragraph and sentence counts, the
 * opening and closing words), which the same PDF has everywhere:
 * - the same key here, if its fingerprint agrees (synced libraries);
 * - else PDFs here whose text contains the document's opening or closing
 *   words (Zotero's full-text index), or whose title does, each checked
 *   against the fingerprint.
 * Matched files are merged into the conversations here (docStore.ts
 * mergeDocFiles); the files here are backed up first. Nothing is guessed:
 * a file without a fingerprint, or with no matching PDF, is reported and
 * left alone.
 */
import { getDocument } from "./document";
import { documentBasis } from "./router";
import { DocFile, fileBasis, getDataDir, loadDoc, mergeDocFiles, parseDocFile, saveDocNow } from "./docStore";
import { hostWindow } from "../utils/window";

export interface ImportResult {
  file: string;
  /** Title of the PDF here, when matched */
  title?: string;
  added: number;
  updated: number;
  /** Why the file was left alone */
  skipped?: string;
}

const FILE_RE = /^(\d+)_([A-Z0-9]{8})\.json$/;

function io() {
  const win = hostWindow();
  return { PathUtils: win.PathUtils, IOUtils: win.IOUtils };
}

/** "319:1166:The Elaboration Likelihood…|…Psychology, 14, 321-328." */
function parseBasis(basis: string) {
  const m = basis.match(/^\d+:\d+:([\s\S]*)$/);
  if (!m) return null;
  const rest = m[1];
  const bar = rest.lastIndexOf("|");
  return bar < 0 ? { first: rest, last: "" } : { first: rest.slice(0, bar), last: rest.slice(bar + 1) };
}

/** A few whole words from a fragment, for a search */
function searchWords(fragment: string, count: number, fromEnd = false) {
  const words = fragment
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  // The fragment is cut mid-word at its edges: drop the partial word there
  const whole = fromEnd ? words.slice(1) : words.slice(0, -1);
  const pick = fromEnd ? whole.slice(-count) : whole.slice(0, count);
  return pick.join(" ");
}

function itemTitle(item: Zotero.Item) {
  const parent: any = item.parentItem || item;
  try {
    return String(parent.getField("title") || item.getField("title") || "");
  } catch {
    return "";
  }
}

async function search(libraryID: number, condition: string, value: string) {
  if (!value) return [] as number[];
  const s = new (Zotero as any).Search();
  s.libraryID = libraryID;
  s.addCondition(condition, "contains", value);
  return (await s.search()) as number[];
}

/** PDF attachments among items (an item stands for its PDFs) */
function pdfAttachments(ids: number[]) {
  const out: Zotero.Item[] = [];
  for (const id of ids) {
    const item = Zotero.Items.get(id) as any;
    if (!item) continue;
    if (item.isPDFAttachment?.()) out.push(item);
    else if (item.isRegularItem?.()) {
      for (const aid of item.getAttachments()) {
        const a = Zotero.Items.get(aid) as any;
        if (a?.isPDFAttachment?.()) out.push(a);
      }
    }
  }
  return out;
}

async function sameDocument(item: Zotero.Item, basis: string) {
  try {
    const kdoc = await getDocument(item.id);
    return !!kdoc && documentBasis(kdoc) === basis;
  } catch {
    return false;
  }
}

/** The PDF here that a file from another computer belongs to */
async function findAttachment(libraryID: number, key: string, basis: string | null): Promise<Zotero.Item | null> {
  const libraries = libraryID === 1 ? [Zotero.Libraries.userLibraryID] : [libraryID, Zotero.Libraries.userLibraryID];
  for (const lib of libraries) {
    const same = Zotero.Items.getByLibraryAndKey(lib, key) as any;
    if (same?.isPDFAttachment?.() && (!basis || (await sameDocument(same, basis)))) return same;
  }
  if (!basis) return null;
  const parts = parseBasis(basis);
  if (!parts) return null;
  const tried = new Set<number>();
  for (const lib of libraries) {
    const ids = [
      ...(await search(lib, "fulltextContent", searchWords(parts.first, 5))),
      ...(await search(lib, "fulltextContent", searchWords(parts.last, 5, true))),
      ...(await search(lib, "title", searchWords(parts.first, 4))),
    ];
    for (const item of pdfAttachments(ids)) {
      if (tried.has(item.id) || tried.size >= 12) continue;
      tried.add(item.id);
      if (await sameDocument(item, basis)) return item;
    }
  }
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Copy the conversation files here aside before anything changes */
async function backUp() {
  const { IOUtils, PathUtils } = io();
  const docs = PathUtils.join(getDataDir(), "docs");
  const dest = PathUtils.join(getDataDir(), "backups", `before-import-${stamp()}`);
  if (await IOUtils.exists(docs)) {
    await IOUtils.makeDirectory(dest, { createAncestors: true, ignoreExisting: true });
    for (const child of await IOUtils.getChildren(docs)) {
      if (child.endsWith(".json")) await IOUtils.copy(child, PathUtils.join(dest, PathUtils.filename(child)));
    }
  }
  return dest;
}

/**
 * Import the conversations in a folder copied from another computer: its
 * `konnash` folder, or the `docs` folder inside it
 */
export async function importConversations(folder: string, onProgress?: (text: string) => void) {
  const { IOUtils, PathUtils } = io();
  const nested = PathUtils.join(folder, "docs");
  const source = (await IOUtils.exists(nested)) ? nested : folder;
  const files = ((await IOUtils.getChildren(source)) as string[]).filter((p) => FILE_RE.test(PathUtils.filename(p)));
  const results: ImportResult[] = [];
  if (!files.length) return { results, backup: null as string | null, empty: true };
  const backup = await backUp();
  for (const [i, path] of files.entries()) {
    const name = PathUtils.filename(path);
    onProgress?.(`Reading ${i + 1} of ${files.length}…`);
    const [, lib, key] = name.match(FILE_RE)!;
    let incoming: DocFile;
    try {
      incoming = parseDocFile(await IOUtils.readUTF8(path));
    } catch {
      results.push({ file: name, added: 0, updated: 0, skipped: "could not be read" });
      continue;
    }
    if (!incoming.chats.length && !incoming.trash.length) {
      results.push({ file: name, added: 0, updated: 0, skipped: "has no conversations" });
      continue;
    }
    const basis = fileBasis(incoming);
    const attachment = await findAttachment(Number(lib), key, basis);
    if (!attachment) {
      results.push({
        file: name,
        added: 0,
        updated: 0,
        skipped: basis
          ? "no PDF here has the same text (add the same PDF to Zotero, then import again)"
          : "it doesn't say which document it belongs to (open that PDF on the other computer once, then copy again)",
      });
      continue;
    }
    // The file loaded here is the one an open pane shows: merge into it
    const target = await loadDoc(attachment);
    const { added, updated } = mergeDocFiles(target, incoming);
    target.basis ||= basis || undefined;
    if (added || updated) await saveDocNow(attachment, target);
    results.push({ file: name, title: itemTitle(attachment), added, updated });
  }
  return { results, backup, empty: false };
}
