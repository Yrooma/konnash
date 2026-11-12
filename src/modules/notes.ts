/**
 * Keeping things from a chat in Zotero itself:
 * - a cited passage as a real highlight annotation (tag "konnash")
 * - a whole chat as a child note, citations turned into quoted sources
 * - an answer, or a selection, added to one of the item's notes or a new one
 */
import { getPageLabel, getSentencePageIndex, KonnashDocument } from "./document";
import { CitationSpan, getSpanHighlight, getSpanText } from "./citations";
import { AnswerBlock, AnswerToken, createCitationNumberer, GENERAL_MARK, InlineText, parseAnswer } from "./ai/answer";
import { describePassage } from "./ai/prompt";
import { StoredChat, StoredMessage } from "./docStore";
import { fromStoredRef, passageMeta } from "./passages";
import { detectDirection, Dir, documentDirection } from "./bidi";

export const KONNASH_COLOR = "#a28ae5";
export const KONNASH_TAG = "konnash";
/** Zotero's note format version, as its own note editor writes it */
const NOTE_SCHEMA = 9;

export async function keepAsHighlight(
  kdoc: KonnashDocument,
  span: CitationSpan,
  comment: string,
) {
  const attachment = Zotero.Items.get(kdoc.attachmentID);
  if (!attachment) throw new Error("PDF not found");
  const position = getSpanHighlight(kdoc, span).evidence;
  if (!position) throw new Error("This passage has no position on the page");
  const top = Math.max(...position.rects.map((r) => r[3]));
  const pageHeight = kdoc.pageHeights[position.pageIndex] || 792;
  const sortIndex = [
    String(position.pageIndex).padStart(5, "0"),
    String(Math.min(span.firstSentence, 999999)).padStart(6, "0"),
    String(Math.max(0, Math.floor(pageHeight - top))).padStart(5, "0"),
  ].join("|");
  const json = {
    key: (Zotero as any).DataObjectUtilities.generateKey(),
    type: "highlight",
    color: KONNASH_COLOR,
    text: getSpanText(kdoc, span),
    comment,
    pageLabel: getPageLabel(kdoc, position.pageIndex),
    sortIndex,
    position,
  };
  const saved: any = await (Zotero.Annotations as any).saveFromJSON(attachment, json);
  if (saved?.addTag) {
    saved.addTag(KONNASH_TAG);
    await saved.saveTx();
  }
  return saved;
}

export function escapeHTML(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function tokensToHTML(tokens: AnswerToken[], numberer: ReturnType<typeof createCitationNumberer>) {
  let html = "";
  tokens.forEach((token, i) => {
    if (token.type === "text") {
      const next = tokens[i + 1];
      let text = escapeHTML(next?.type === "cite" && !next.inline ? token.text.replace(/\s+$/, "") : token.text);
      if (token.code) text = `<code>${text}</code>`;
      if (token.italic) text = `<em>${text}</em>`;
      if (token.bold) text = `<strong>${text}</strong>`;
      html += text;
    } else if (token.general) {
      html += `<sup title="Background knowledge, not from this document">${GENERAL_MARK}</sup>`;
    } else {
      const { items } = numberer.number(token.spec);
      // A bare id keeps the model's words, numbered when it exists
      if (token.inline) html += escapeHTML(token.inline);
      if (items.length) html += `<sup>${items.map((x) => x.n).join(",")}</sup>`;
    }
  });
  return html;
}

/** dir attribute for a note block (Zotero notes are LTR unless told) */
function dirAttr(dir: Dir | null | undefined) {
  return dir === "rtl" ? ' dir="rtl"' : "";
}

function tokensText(tokens: AnswerToken[]) {
  return tokens.map((t) => (t.type === "text" ? t.text : "")).join("");
}

function inlineHTML(text: InlineText, numberer: ReturnType<typeof createCitationNumberer>) {
  return text.map((s) => tokensToHTML(s.tokens, numberer)).join(" ");
}

function inlinePlain(text: InlineText) {
  return text.map((s) => tokensText(s.tokens)).join(" ");
}

/**
 * An answer as HTML, block by block as the panel shows it: paragraphs,
 * headings, lists, tables, quotes and code, each block in the direction of
 * its own words (or the reader's choice, `forced`), citations numbered.
 */
export function answerHTML(
  text: string,
  numberer: ReturnType<typeof createCitationNumberer>,
  options: { forced?: Dir | null; fallback: Dir },
) {
  const overall = options.forced || detectDirection(text) || options.fallback;
  const dirOf = (words: string) => options.forced || detectDirection(words, 3) || overall;
  const blockPlain = (b: AnswerBlock): string =>
    b.kind === "paragraph" || b.kind === "heading"
      ? inlinePlain(b.sentences)
      : b.kind === "list"
        ? b.items.map((item) => item.map(blockPlain).join(" ")).join(" ")
        : b.kind === "quote"
          ? b.blocks.map(blockPlain).join(" ")
          : b.kind === "table"
            ? [...b.head, ...b.rows.flat()].map(inlinePlain).join(" ")
            : "";
  const render = (b: AnswerBlock): string => {
    switch (b.kind) {
      case "paragraph":
        return `<p${dirAttr(dirOf(inlinePlain(b.sentences)))}>${inlineHTML(b.sentences, numberer)}</p>`;
      case "heading": {
        // Headings inside an answer sit under the note's own h1/h2
        const level = Math.min(6, Math.max(3, b.level + 2));
        return `<h${level}${dirAttr(dirOf(inlinePlain(b.sentences)))}>${inlineHTML(b.sentences, numberer)}</h${level}>`;
      }
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
        const items = b.items
          .map((item) =>
            item.length === 1 && item[0].kind === "paragraph"
              ? `<li>${inlineHTML(item[0].sentences, numberer)}</li>`
              : `<li>${item.map(render).join("")}</li>`,
          )
          .join("");
        return `<${tag}${start}${dirAttr(dirOf(blockPlain(b)))}>${items}</${tag}>`;
      }
      case "quote":
        return `<blockquote${dirAttr(dirOf(blockPlain(b)))}>${b.blocks.map(render).join("")}</blockquote>`;
      case "table": {
        const tableDir = dirOf(blockPlain(b));
        const cell = (tag: "th" | "td", t: InlineText) => {
          const own = options.forced || detectDirection(inlinePlain(t)) || tableDir;
          return `<${tag}${own !== tableDir ? ` dir="${own}"` : ""}>${inlineHTML(t, numberer)}</${tag}>`;
        };
        const head = b.head.length ? `<tr>${b.head.map((h) => cell("th", h)).join("")}</tr>` : "";
        const rows = b.rows.map((r) => `<tr>${r.map((d) => cell("td", d)).join("")}</tr>`).join("");
        return `<table${tableDir === "rtl" ? ' dir="rtl"' : ""}>${head}${rows}</table>`;
      }
      case "code":
        return `<pre>${escapeHTML(b.text)}</pre>`;
      case "rule":
        return "<hr>";
    }
  };
  return parseAnswer(text).map(render).join("\n");
}

/** A cited place in a list of sources: its words (shortened) and its page */
function sourceOf(kdoc: KonnashDocument, span: CitationSpan) {
  const pageIndex = getSentencePageIndex(kdoc, span.firstSentence);
  const quote = getSpanText(kdoc, span);
  return {
    pageIndex,
    quote,
    short: quote.length > 300 ? `${quote.slice(0, 300)}…` : quote,
    page: pageIndex === null ? "" : `p. ${getPageLabel(kdoc, pageIndex)}`,
  };
}

/** The numbered sources of an answer: quoted passage and page */
export function sourcesHTML(
  kdoc: KonnashDocument,
  numberer: ReturnType<typeof createCitationNumberer>,
  openURL?: (pageIndex: number) => string,
) {
  if (!numberer.list.length) return "";
  const docDir = documentDirection(kdoc);
  const sources = numberer.list.map(({ n, span }) => {
    const { pageIndex, quote, short, page: label } = sourceOf(kdoc, span);
    const page = !label
      ? ""
      : openURL
        ? ` (<a href="${escapeHTML(openURL(pageIndex!))}">${escapeHTML(label)}</a>)`
        : ` (${escapeHTML(label)})`;
    return `<li value="${n}"${dirAttr(detectDirection(quote, 3) || docDir)}>“${escapeHTML(short)}”${page}</li>`;
  });
  return `<p><strong>Sources</strong></p><ol>${sources.join("")}</ol>`;
}

/** The same sources as plain text, for pasting where there is no formatting */
export function sourcesText(kdoc: KonnashDocument, numberer: ReturnType<typeof createCitationNumberer>) {
  if (!numberer.list.length) return "";
  const lines = numberer.list.map(({ n, span }) => {
    const { short, page } = sourceOf(kdoc, span);
    return `${n}. “${short}”${page ? ` (${page})` : ""}`;
  });
  return ["Sources", ...lines].join("\n");
}

/** A question as a note heading, followed by the passage it was about */
export function questionHTML(kdoc: KonnashDocument, message: StoredMessage) {
  const parts = [`<h2${dirAttr(detectDirection(message.text))}>${escapeHTML(message.text)}</h2>`];
  const ref = message.passage ? fromStoredRef(kdoc, message.passage) : null;
  if (ref) {
    const text = describePassage(kdoc, ref).text;
    const dir = dirAttr(detectDirection(text, 3) || documentDirection(kdoc));
    parts.push(`<blockquote${dir}><p>“${escapeHTML(text)}” <em>(${escapeHTML(passageMeta(kdoc, ref))})</em></p></blockquote>`);
  }
  return parts.join("\n");
}

/** An answer as note HTML, numbered on its own and followed by its sources */
export function answerNoteHTML(kdoc: KonnashDocument, message: StoredMessage, openURL?: (pageIndex: number) => string) {
  if (!message.text) return "";
  const numberer = createCitationNumberer(kdoc);
  // As in the panel: the reader's choice, else each block's own language
  const html = answerHTML(message.text, numberer, { forced: message.dir, fallback: documentDirection(kdoc) });
  const sources = sourcesHTML(kdoc, numberer, openURL);
  return sources ? `${html}\n${sources}` : html;
}

/** One question and its answer, as kept in a note */
export function turnNoteHTML(
  kdoc: KonnashDocument,
  question: StoredMessage | undefined,
  answer: StoredMessage,
  openURL?: (pageIndex: number) => string,
) {
  return [question?.role === "user" ? questionHTML(kdoc, question) : "", answerNoteHTML(kdoc, answer, openURL)]
    .filter(Boolean)
    .join("\n");
}

/** The top of a note Konnash starts: the conversation, the document, when */
function noteHeadingHTML(chatTitle: string, docTitle: string, time: number) {
  return [
    `<h1${dirAttr(detectDirection(chatTitle))}>Konnash: ${escapeHTML(chatTitle)}</h1>`,
    `<p><em>${escapeHTML(docTitle)} · ${new Date(time).toLocaleString()}</em></p>`,
  ].join("\n");
}

/** A conversation's questions and answers, each answer with its own sources */
export function conversationNoteHTML(kdoc: KonnashDocument, chat: StoredChat, openURL?: (pageIndex: number) => string) {
  return chat.messages
    .map((message) => (message.role === "user" ? questionHTML(kdoc, message) : answerNoteHTML(kdoc, message, openURL)))
    .filter(Boolean)
    .join("\n");
}

/** Note HTML for a chat: questions, answers, and each answer's sources */
export function buildNoteHTML(
  kdoc: KonnashDocument,
  chat: StoredChat,
  options: { title: string; openURL: (pageIndex: number) => string },
) {
  const parts = [noteHeadingHTML(chat.title, options.title, chat.updated || Date.now()), conversationNoteHTML(kdoc, chat, options.openURL)];
  return `<div data-schema-version="${NOTE_SCHEMA}">${parts.filter(Boolean).join("\n")}</div>`;
}

/**
 * A note's HTML with more added at its end. Zotero keeps a note inside one
 * <div data-schema-version>; what is added goes inside it.
 */
export function appendToNoteHTML(current: string, html: string) {
  if (/^\s*<div\b[^>]*\bdata-schema-version\b[^>]*>[\s\S]*<\/div>\s*$/.test(current)) {
    return current.replace(/<\/div>\s*$/, `\n${html}</div>`);
  }
  return current ? `${current}\n${html}` : `<div data-schema-version="${NOTE_SCHEMA}">${html}</div>`;
}

/** Page links that open this PDF in Zotero, as Zotero's own notes link to it */
export function pageLinks(kdoc: KonnashDocument) {
  const attachment = Zotero.Items.get(kdoc.attachmentID);
  if (!attachment) throw new Error("PDF not found");
  const library = Zotero.Libraries.get(attachment.libraryID) as any;
  const base =
    library?.libraryType === "group"
      ? `zotero://open-pdf/groups/${library.groupID}/items/${attachment.key}`
      : `zotero://open-pdf/library/items/${attachment.key}`;
  return (pageIndex: number) => `${base}?page=${pageIndex + 1}`;
}

/** The notes of the PDF's item, most recently changed first (none for a PDF on its own) */
export function itemNotes(kdoc: KonnashDocument): Zotero.Item[] {
  const attachment = Zotero.Items.get(kdoc.attachmentID) as Zotero.Item | false;
  const parent = attachment && attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : null;
  if (!parent) return [];
  const notes = Zotero.Items.get(parent.getNotes(false)) as Zotero.Item[];
  return notes
    .filter((note) => note && !note.deleted)
    .sort((a, b) => String(b.dateModified).localeCompare(String(a.dateModified)));
}

/**
 * Add HTML to the end of one of the item's notes, or to a new note on the
 * item (which starts with the conversation's heading). A note open in
 * Zotero's editor shows the addition at once.
 */
export async function addToNote(
  kdoc: KonnashDocument,
  html: string,
  target: Zotero.Item | null,
  heading: { chatTitle: string; docTitle: string },
) {
  const attachment = Zotero.Items.get(kdoc.attachmentID);
  if (!attachment) throw new Error("PDF not found");
  const libraryID = target ? target.libraryID : attachment.libraryID;
  if ((Zotero.Libraries.get(libraryID) as any)?.editable === false) throw new Error("this library is read-only");
  if (target) {
    target.setNote(appendToNoteHTML(target.getNote() || "", html));
    await target.saveTx();
    return target;
  }
  const note = new Zotero.Item("note");
  note.libraryID = attachment.libraryID;
  if (attachment.parentItemID) note.parentID = attachment.parentItemID;
  note.setNote(
    `<div data-schema-version="${NOTE_SCHEMA}">${noteHeadingHTML(heading.chatTitle, heading.docTitle, Date.now())}\n${html}</div>`,
  );
  note.addTag(KONNASH_TAG);
  await note.saveTx();
  return note;
}
