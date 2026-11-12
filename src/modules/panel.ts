/**
 * The Konnash panel for one PDF, rendered inside a shadow root (so Zotero's
 * own styles can't reach it) with its stylesheet bundled in.
 *
 * - Header: title, Notebook, New conversation, ⋯ (status, text size, note,
 *   highlight, Trash, settings).
 * - Body: one conversation stream. A question about a passage appears as a
 *   quoted reply; follow-ups continue from it. Or the Notebook.
 * - Question box: the scope selector ("what is this question about?":
 *   whole document, most relevant sections, a passage), suggestions (✦),
 *   the main model, send. With a passage attached its quote sits in the box and Enter runs
 *   the recommended passage prompt.
 */
import panelCSS from "../../addon/content/panel.css";
import { KonnashDocument } from "./document";
import { CitationSpan, parseCitation } from "./citations";
import { checkAnswer } from "./ai/answer";
import { ask, ChatTurn } from "./ai/client";
import { buildPassageQuestion, describePassage, estimateTokens, PassageRef } from "./ai/prompt";
import { AISettings, effortLevels, getSettings, getSettingsProblem, setEffort } from "./ai/providers";
import { fetchModels, findCachedModel, formatContext, getCachedModels } from "./ai/models";
import { config } from "../../package.json";
import { openSettings } from "./preferences";
import { clearHighlight, getSelectedReader, hasKonnashHighlight, HighlightMode, watchOutsidePress } from "./highlighter";
import { createHoverCard, getSpanPageLabel, renderAnswer, renderContextLine, renderFooter, renderThinking } from "./answerView";
import { applyBlockDirections, detectDirection, Dir, DirSetting, documentDirection, interfaceDirection, setAutoDir } from "./bidi";
import { chatTitleFrom, DocFile, emptyDocFile, loadDoc, newChat, saveDoc, StoredChat, StoredMessage } from "./docStore";
import { addToNote, conversationNoteHTML, itemNotes, keepAsHighlight, pageLinks, turnNoteHTML } from "./notes";
import { clipToNote, readClip } from "./clip";
import { isFocusMode } from "./focusMode";
import { decideRoute, documentBasis } from "./router";
import { getSections, SourceInfo } from "./structure";
import { askedParagraphs, fromStoredRef, passageMeta, passageSpan, toStoredRef } from "./passages";
import { createNotebookView } from "./notebookView";
import { withLinkedParagraphs } from "./links";
import { ExplainTarget, isClickModeAvailable, isClickModeOn, PickMode, startClickMode, stopClickMode } from "./explain";
import { getPassageDefault, getPrompts, PromptDef } from "./prompts";
import { createPopoverHost, editInPlace, el, foldWhenLong, icon, iconButton, MenuEntry, toast } from "./ui";
import { getPref, setPref } from "../utils/prefs";
import { ACCEL_CLICK } from "../utils/window";

const MIN_FONT = 11;
const MAX_FONT = 20;

type Scope = "document" | "focus" | "passage";

/** Open conversation per attachment, kept while Zotero runs */
const openChatIDs = new Map<number, string>();
/** Attachments whose "no-ai" warning was closed, while Zotero runs */
const noAIWarned = new Set<number>();

export interface PanelOptions {
  kdoc: KonnashDocument;
  attachment: Zotero.Item;
  title: string;
  source: SourceInfo;
  /** Show a span in the PDF; "persistent" when it stays highlighted */
  showSpan: (span: CitationSpan) => Promise<HighlightMode | void> | void;
  /** Paragraphs asked about changed (markers elsewhere) */
  onAskedChange?: (paragraphs: Set<number>) => void;
}

export function createPanel(doc: Document, host: HTMLElement, options: PanelOptions) {
  const { kdoc, attachment, title, source } = options;
  const win = doc.defaultView as Window;
  const attachmentID = attachment.id;

  // Shadow root with the bundled stylesheet
  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const style = el(doc, "style");
  style.textContent = panelCSS;
  shadow.append(style);
  const root = el(doc, "div", "k-panel");
  shadow.append(root);

  const fontSize = () => Math.min(MAX_FONT, Math.max(MIN_FONT, Number(getPref("fontSize")) || 14));
  const applyFontSize = () => root.style.setProperty("--k-font", `${fontSize()}px`);
  applyFontSize();

  // Reading direction: the panel's chrome follows Zotero; what is read
  // (answers, questions, passages) follows its own language, unless the
  // reader chose a direction (⋯ → Text direction, or per answer)
  root.dir = (win.getComputedStyle(host)?.direction as Dir) || interfaceDirection();
  const docDir = documentDirection(kdoc);
  const chosenDir = (): Dir | null => {
    const value = getPref("textDirection") as DirSetting;
    return value === "rtl" || value === "ltr" ? value : null;
  };

  // Fill the pane in full-pane mode
  const syncFill = () => host.classList.toggle("k-fill", isFocusMode(doc));
  syncFill();
  const observer = new (win as any).MutationObserver(syncFill);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-konnash-view"] });

  const popovers = createPopoverHost(doc, root);

  // Header --------------------------------------------------------------------
  const head = el(doc, "div", "k-head");
  const headTitle = el(doc, "div", "k-head-title");
  const notebookButton = iconButton(doc, "notebook", "Notebook: contents, passages and conversations", () => toggleNotebook());
  const newButton = iconButton(doc, "plus", "New conversation", () => {
    view = "chat";
    if (highlighted) clearPDFHighlight();
    openChat(newChat());
    input.focus();
  });
  const moreButton = iconButton(doc, "more", "More", () => openMoreMenu());
  head.append(headTitle, notebookButton, newButton, moreButton);

  const banner = el(doc, "div", "k-banner");
  banner.hidden = true;

  const body = el(doc, "div", "k-body");
  const stream = el(doc, "div", "k-stream");

  // Question box ---------------------------------------------------------------
  const composer = el(doc, "div", "k-composer");
  const pills = el(doc, "div", "k-pills");
  const box = el(doc, "div", "k-box");
  const boxBanner = el(doc, "div", "k-box-banner");
  const boxQuote = el(doc, "div", "k-box-quote");
  const input = el(doc, "textarea", "k-input");
  input.rows = 2;
  const bar = el(doc, "div", "k-box-bar");
  const scopeButton = el(doc, "button", "k-scope");
  scopeButton.title = "What is this question about? To ask about one passage, choose “A passage…”, or select text or right-click a paragraph in the PDF.";
  const suggestButton = iconButton(doc, "sparkle", "Suggested prompts", () => openSuggestions());
  // The main model, switchable here as in any chat app (the helper model
  // stays in settings)
  const modelButton = el(doc, "button", "k-scope k-model");
  const sendButton = el(doc, "button", "k-send");
  bar.append(scopeButton, suggestButton, el(doc, "span", "k-spacer"), modelButton, sendButton);
  box.append(boxBanner, boxQuote, input, bar);
  composer.append(pills, box);

  // What is highlighted in the PDF, with Clear one click away. It floats
  // just above the question box, in the chat and in the Notebook
  const dock = el(doc, "div", "k-dock");
  const highlightChip = el(doc, "div", "k-hl");
  highlightChip.hidden = true;
  highlightChip.setAttribute("role", "status");
  // Notices about sending this document (first use, "no-ai" tag)
  const notices = el(doc, "div", "k-notices");
  // While an answer arrives below what the reader is looking at: "↓ more"
  const moreBelow = el(doc, "button", "k-more-below", "↓");
  moreBelow.hidden = true;
  moreBelow.title = "The answer continues below";
  moreBelow.setAttribute("aria-label", "Scroll to the end of the answer");
  dock.append(moreBelow, notices, highlightChip, composer);
  const isAtEnd = () => body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  let answerArriving = false;
  const renderMoreBelow = (arriving = answerArriving) => {
    answerArriving = arriving;
    moreBelow.hidden = !arriving || isAtEnd();
  };
  moreBelow.addEventListener("click", () => {
    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  });

  root.append(head, banner, body, dock);

  // Highlight in the PDF ----------------------------------------------------------
  // A highlight is a trace of the last thing looked at, not something kept:
  // the chip says what is highlighted and clears it in one click (or Esc)
  let highlighted: { span: CitationSpan | null } | null = null;
  const thisReader = () => {
    const reader = getSelectedReader(win) as any;
    return reader?.itemID === attachmentID ? reader : null;
  };
  const renderHighlightChip = (pulse = false) => {
    root.classList.toggle("k-has-hl", !!highlighted);
    highlightChip.hidden = !highlighted;
    highlightChip.replaceChildren();
    if (!highlighted) return;
    const span = highlighted.span;
    const again = el(doc, "button", "k-hl-show");
    again.append(el(doc, "span", "k-hl-dot"));
    const label = el(doc, "span", "k-hl-label", span ? "Highlighted " : "Highlighted in the PDF");
    if (span) label.append(el(doc, "span", "k-hl-where", [getSpanPageLabel(kdoc, span), span.label].filter(Boolean).join(" · ")));
    again.append(label);
    if (span) {
      again.title = "Highlighted in the PDF · click to show it again";
      again.addEventListener("click", () => showSpan(span));
    } else {
      again.disabled = true;
    }
    const clear = el(doc, "button", "k-hl-clear");
    clear.title = "Clear the highlight in the PDF (Esc)";
    clear.append(icon(doc, "close"), el(doc, "span", undefined, "Clear"));
    clear.addEventListener("click", () => clearPDFHighlight());
    highlightChip.append(again, clear);
    if (pulse) {
      highlightChip.classList.remove("k-pulse");
      void highlightChip.offsetWidth;
      highlightChip.classList.add("k-pulse");
    }
  };
  // Pressing on the PDF away from the highlighted passage clears it: the
  // reader has moved on (to select text, to read on)
  let stopWatchingPDF: (() => void) | null = null;
  const watchPDF = () => {
    stopWatchingPDF?.();
    const reader = thisReader();
    stopWatchingPDF = reader ? watchOutsidePress(reader, () => clearPDFHighlight()) : null;
  };
  /** The highlight is gone (cleared, or replaced by pick mode's outline) */
  const forgetHighlight = () => {
    stopWatchingPDF?.();
    stopWatchingPDF = null;
    highlighted = null;
    root.querySelectorAll(".konnash-cite-active").forEach((c: Element) => c.classList.remove("konnash-cite-active"));
    renderHighlightChip();
  };
  const clearPDFHighlight = () => {
    const reader = thisReader();
    if (reader) clearHighlight(reader);
    forgetHighlight();
  };
  const showSpan = async (span: CitationSpan) => {
    const mode = await options.showSpan(span);
    if (mode !== "persistent") return;
    highlighted = { span };
    renderHighlightChip(true);
    watchPDF();
  };
  // Esc anywhere in the panel clears it, when Esc has nothing else to do
  root.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented && highlighted) {
      event.preventDefault();
      clearPDFHighlight();
    }
  });

  const answerActions = {
    showSpan,
    keepHighlight: async (span: CitationSpan, comment: string) => {
      await keepAsHighlight(kdoc, span, comment);
    },
  };
  const card = createHoverCard(doc, root, kdoc, answerActions);
  body.addEventListener("scroll", () => {
    card.hide();
    popovers.close();
    renderMoreBelow();
  });

  const showSection = (sectionID: string) => {
    const s = getSections(kdoc).find((x) => x.id === sectionID);
    if (!s) return;
    const first = kdoc.paragraphs[s.start].id;
    const last = kdoc.paragraphs[Math.min(s.end, s.start + 2)].id;
    const span = parseCitation(kdoc, first === last ? first : `${first}–${last}`).spans[0];
    if (span) showSpan(span);
  };

  // State -----------------------------------------------------------------------
  let file: DocFile = emptyDocFile();
  let loaded = false;
  const waiting: { target: ExplainTarget; mode: PickMode }[] = [];
  let chat: StoredChat = newChat();
  let view: "chat" | "notebook" = "chat";
  let controller: AbortController | null = null;
  let scope: Scope = "document";
  let attached: PassageRef | null = null;
  let picking = false;
  let inserted: PromptDef | null = null;

  const persist = () => saveDoc(attachment, file);
  const notifyAsked = () => options.onAskedChange?.(askedParagraphs(kdoc, file));

  const notebook = createNotebookView(doc, root, {
    kdoc,
    getFile: () => file,
    save: persist,
    currentChatID: () => (chat.messages.length ? chat.id : null),
    openChat: (chatID, messageIndex) => {
      const target = file.chats.find((c) => c.id === chatID);
      if (!target) return;
      view = "chat";
      openChat(target, messageIndex);
    },
    showSpan,
    showSection,
    onChange: () => {
      if (!file.chats.includes(chat)) chat = newChat();
      notifyAsked();
    },
  });

  // Rendering ---------------------------------------------------------------------
  const renderHeader = () => {
    headTitle.replaceChildren();
    if (view === "notebook") {
      const back = el(doc, "button", "k-back");
      back.append(icon(doc, "back"), doc.createTextNode("Notebook"));
      back.title = "Back to the conversation";
      back.addEventListener("click", () => toggleNotebook(false));
      headTitle.removeAttribute("dir");
      headTitle.append(back);
    } else {
      headTitle.append(doc.createTextNode(chat.messages.length ? chat.title : "Konnash"));
      // A new conversation: the name, and under it only what Konnash is for
      if (!chat.messages.length) headTitle.append(el(doc, "span", "k-tagline", "AI for Scholars"));
      headTitle.title = chat.messages.length ? `${chat.title}\nDouble-click to rename` : "";
      if (chat.messages.length) setAutoDir(headTitle, chat.title);
      else headTitle.removeAttribute("dir");
    }
    notebookButton.classList.toggle("k-active", view === "notebook");
    newButton.hidden = view === "notebook";
  };
  /** Rename the open conversation, in the header */
  const renameChat = () => {
    if (view !== "chat" || !chat.messages.length) return;
    headTitle.removeAttribute("title");
    editInPlace(doc, headTitle, chat.title, (name) => {
      if (name) {
        chat.title = name;
        persist();
      }
      renderHeader();
    });
  };
  headTitle.addEventListener("dblclick", () => renameChat());

  const renderBanner = () => {
    const problem = getSettingsProblem(getSettings());
    banner.hidden = !problem;
    banner.replaceChildren();
    if (problem) {
      banner.append(doc.createTextNode(problem));
      const open = el(doc, "button", undefined, "Open settings");
      open.addEventListener("click", () => openSettings());
      banner.append(open);
    }
  };

  const quoteBlock = (ref: PassageRef | null, fallback: string) => {
    const quote = el(doc, "div", "k-quote");
    quote.append(el(doc, "span", "k-quote-meta", ref ? passageMeta(kdoc, ref) : fallback));
    if (ref) {
      const text = describePassage(kdoc, ref).text;
      setAutoDir(quote, text, docDir, 3);
      quote.append(el(doc, "span", "k-quote-text", `“${text}”`));
      quote.title = "Show in PDF";
      quote.addEventListener("click", () => {
        // Selecting its words is not a click on it
        if (win.getSelection()?.isCollapsed === false) return;
        const span = passageSpan(kdoc, ref);
        if (span) showSpan(span);
      });
    }
    return quote;
  };

  // Copying and keeping what was read --------------------------------------------
  // A selection may run across several questions and answers: it is
  // numbered as one piece, with the sources of what it cites, and links to
  // the PDF's pages as in Zotero's own notes
  const noteLinks = () => {
    try {
      return pageLinks(kdoc);
    } catch {
      return undefined;
    }
  };
  /** The selection, when it is in this conversation */
  const selectedClip = () => {
    const selection = win.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!stream.contains(range.commonAncestorContainer)) return null;
    return clipToNote(kdoc, readClip(range.cloneContents()), noteLinks());
  };
  const copyClip = (clip: { html: string; text: string }) =>
    new ztoolkit.Clipboard().addText(clip.text, "text/unicode").addText(clip.html, "text/html").copy();

  /** The note last added to, offered first next time */
  let lastNoteID: number | null = null;
  const addTo = async (target: Zotero.Item | null, html: string) => {
    try {
      const note = await addToNote(kdoc, html, target, { chatTitle: chat.title, docTitle: title });
      lastNoteID = note.id;
      const pane = (Zotero.getMainWindow() as any)?.ZoteroPane;
      const open = pane?.openNoteWindow ? { label: "Open", run: () => pane.openNoteWindow(note.id) } : undefined;
      toast(doc, root, target ? `Added to “${note.getNoteTitle() || "the note"}”.` : "Added to a new note on this item.", open);
    } catch (e: any) {
      toast(doc, root, `Could not add to the note: ${e?.message || e}`);
    }
  };
  /** Which note: one of this item's notes (most recent first), or a new one */
  const chooseNote = (
    at: { anchor: HTMLElement; placement?: "below" | "above" } | { x: number; y: number },
    html: string,
  ) => {
    const notes = itemNotes(kdoc);
    if (!notes.length) return void addTo(null, html);
    const recent = notes.slice(0, 8);
    const last = notes.find((n) => n.id === lastNoteID);
    if (last && !recent.includes(last)) recent.unshift(last);
    const entries: MenuEntry[] = [
      { label: "New note", icon: "plus", description: "On this item", onSelect: () => addTo(null, html) },
      "separator",
      ...recent.map((note) => {
        const date = (Zotero as any).Date?.sqlToDate?.(note.dateModified, true) as Date | undefined;
        return {
          label: note.getNoteTitle() || "Untitled note",
          description: date ? `Changed ${date.toLocaleDateString()}` : undefined,
          icon: "note",
          selected: note.id === lastNoteID,
          onSelect: () => addTo(note, html),
        };
      }),
    ];
    if ("anchor" in at) popovers.show(at.anchor, entries, at.placement || "above");
    else popovers.showAt(at.x, at.y, entries);
  };

  // Ctrl+C (⌘C), dragging into a note, and right-click: the same clean copy
  stream.addEventListener("copy", (event: ClipboardEvent) => {
    const clip = selectedClip();
    if (!clip || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", clip.text);
    event.clipboardData.setData("text/html", clip.html);
    event.preventDefault();
  });
  stream.addEventListener("dragstart", (event: DragEvent) => {
    const clip = selectedClip();
    if (!clip || !event.dataTransfer) return;
    event.dataTransfer.setData("text/plain", clip.text);
    event.dataTransfer.setData("text/html", clip.html);
  });
  stream.addEventListener("contextmenu", (event: MouseEvent) => {
    const clip = selectedClip();
    if (!clip) return;
    event.preventDefault();
    const { clientX: x, clientY: y } = event;
    popovers.showAt(x, y, [
      {
        label: "Copy",
        icon: "copy",
        description: "With the sources it cites",
        onSelect: () => {
          copyClip(clip);
          toast(doc, root, "Copied.");
        },
      },
      { label: "Add to note…", icon: "note", description: "One of this item's notes, or a new one", onSelect: () => chooseNote({ x, y }, clip.html) },
    ]);
  });

  const renderEmpty = () => {
    const empty = el(doc, "div", "k-empty");
    const cards = el(doc, "div", "k-cards");
    const starters = getPrompts("document").slice(0, 4);
    if (!starters.length) {
      const note = el(doc, "div", "k-empty-hint");
      note.append(doc.createTextNode("Your suggested prompts are hidden. "));
      const show = el(doc, "button", "k-text-btn", "Show them in Settings");
      show.addEventListener("click", () => openSettings());
      note.append(show);
      empty.append(note);
    }
    for (const prompt of starters) {
      const c = el(doc, "button", "k-card");
      c.append(el(doc, "span", "k-card-title", prompt.label), el(doc, "span", "k-card-text", prompt.text));
      setAutoDir(c, `${prompt.label} ${prompt.text}`);
      c.title = `${prompt.recommended ? "Recommended" : "Your prompt"} · click to use, ${ACCEL_CLICK} to send now`;
      c.addEventListener("click", (event: MouseEvent) => usePrompt(prompt, event.ctrlKey || event.metaKey));
      cards.append(c);
    }
    empty.append(cards);
    return empty;
  };

  const renderAnswerBody = (
    message: StoredMessage,
    isLast: boolean,
    streaming: boolean,
    status?: string,
    /** The same answer's body a moment ago: finished blocks are kept as they are */
    previous?: HTMLElement | null,
  ) => {
    const a = el(doc, "div", "k-a");
    if (!message.text && !message.error) {
      if (status) a.append(el(doc, "div", "konnash-thinking", status));
      else {
        const live = renderThinking(doc, message.thinking, message.thinkingMs, true)!;
        const tail = live.querySelector(".konnash-think-tail") as HTMLElement | null;
        if (tail) setAutoDir(tail, message.thinking, message.dir || chosenDir() || docDir, 3);
        a.append(live);
      }
      return a;
    }
    const forced = message.dir || chosenDir();
    let dir: Dir = forced || detectDirection(message.text) || docDir;
    const thinking = renderThinking(doc, message.thinking, message.thinkingMs, false, { kdoc, card, actions: answerActions });
    if (thinking) a.append(thinking);
    let answerEl: HTMLElement | null = null;
    if (message.text) {
      answerEl = renderAnswer(doc, kdoc, message.text, answerActions, card, {
        previous: previous?.querySelector(".konnash-answer") as HTMLElement | null,
        streaming,
      });
      dir = applyBlockDirections(answerEl, { forced, fallback: docDir });
      a.append(answerEl);
    }
    const thinkingBody = thinking?.querySelector(".konnash-think-body") as HTMLElement | null;
    if (thinkingBody) applyBlockDirections(thinkingBody, { forced, fallback: dir });
    if (message.error) a.append(el(doc, "div", "k-error", message.error));
    if (answerEl && message.meta) a.append(renderFooter(doc, answerEl, checkAnswer(kdoc, message.text), message.meta));
    if (message.text && !streaming) {
      const tools = el(doc, "div", "konnash-a-tools");
      const copy = el(doc, "button", "konnash-link-quiet", "Copy");
      copy.title = "Copy the answer with its sources (tables and lists kept)";
      copy.addEventListener("click", () => {
        // As if the whole answer were selected: rich text where it can be
        // pasted (notes, word processors), plain text with numbers elsewhere
        const clip = answerEl ? clipToNote(kdoc, readClip(answerEl), noteLinks()) : null;
        if (!clip) return;
        copyClip(clip);
        copy.textContent = "Copied";
      });
      // This question and answer, kept in one of the item's notes
      const keep = el(doc, "button", "konnash-link-quiet", "Add to note");
      keep.title = "Add this question and answer, with its sources, to one of this item's notes or a new one";
      keep.addEventListener("click", () => {
        const question = chat.messages[chat.messages.indexOf(message) - 1];
        chooseNote({ anchor: keep }, turnNoteHTML(kdoc, question, message, noteLinks()));
      });
      tools.append(copy, keep);
      // Per answer: read it the other way, or back to automatic
      const flip = el(doc, "button", "konnash-link-quiet", message.dir ? "Auto direction" : dir === "rtl" ? "Read left-to-right" : "Read right-to-left");
      flip.title = message.dir
        ? "Let Konnash choose the direction of each paragraph again"
        : "Show this answer in the other reading direction";
      flip.addEventListener("click", () => {
        message.dir = message.dir ? undefined : dir === "rtl" ? "ltr" : "rtl";
        persist();
        const turn = a.closest(".k-turn") as HTMLElement | null;
        if (turn) turn.replaceWith(renderTurn(Number(turn.dataset.index)));
      });
      tools.append(flip);
      if (isLast) {
        const retry = el(doc, "button", "konnash-link-quiet", "Retry");
        retry.addEventListener("click", () => retryLast());
        tools.append(retry);
      }
      a.append(tools);
    }
    return a;
  };

  /** One turn: (quote) question, context line, answer */
  const renderTurn = (index: number) => {
    const user = chat.messages[index];
    const answer = chat.messages[index + 1];
    const turn = el(doc, "div", "k-turn");
    turn.dataset.index = String(index);
    if (user.passage) turn.append(quoteBlock(fromStoredRef(kdoc, user.passage), `${user.passage.anchor.pid} (not found in this version of the PDF)`));
    const q = el(doc, "div", "k-q");
    if (user.label) {
      q.classList.add("k-q-tag");
      q.append(el(doc, "span", "k-q-label", user.label));
    } else {
      // A long question folds after a few lines, as in any chat
      const text = el(doc, "span", "k-q-text", user.text);
      q.append(text);
      setAutoDir(q, user.text, answer?.dir || null);
      if (chosenDir()) q.dir = chosenDir()!;
      foldWhenLong(doc, q, text);
    }
    turn.append(q);
    if (answer?.role === "assistant") {
      const context = renderContextLine(doc, answer.routing, showSection);
      if (context) turn.append(context);
      turn.append(renderAnswerBody(answer, index + 1 === chat.messages.length - 1, false));
    }
    return turn;
  };

  const renderStream = () => {
    card.hide();
    stream.replaceChildren();
    if (!chat.messages.length) stream.append(renderEmpty());
    for (let i = 0; i < chat.messages.length; i += 2) {
      if (chat.messages[i].role === "user") stream.append(renderTurn(i));
    }
  };

  const renderBody = () => {
    body.replaceChildren(view === "chat" ? stream : notebook.root);
    composer.hidden = view !== "chat";
    renderHeader();
  };

  /**
   * "Most relevant sections" chooses what a conversation starts from. Its
   * follow-ups read the whole document (the provider keeps it ready, and
   * earlier answers stay in view), so for them the choice isn't offered
   */
  const isFollowUp = () => chat.messages.length > 0;
  const focusOn = () => scope === "focus" && !isFollowUp();
  const scopeInfo = () => {
    if (scope === "passage") {
      if (picking && !attached) return { icon: "pick", label: "Pick a paragraph…", on: true };
      return { icon: "passage", label: attached ? `Passage · ${describePassage(kdoc, attached).label}` : "A passage", on: true };
    }
    if (focusOn()) return { icon: "focus", label: "Relevant sections", on: true };
    return { icon: "document", label: "Whole document", on: false };
  };

  const renderComposer = () => {
    const info = scopeInfo();
    scopeButton.replaceChildren(icon(doc, info.icon), el(doc, "span", "k-scope-label", info.label), icon(doc, "chevronDown", "k-icon k-chev"));
    scopeButton.classList.toggle("k-on", info.on);

    boxBanner.hidden = !picking;
    boxBanner.replaceChildren();
    if (picking) boxBanner.append(icon(doc, "pick"), doc.createTextNode("Click a paragraph in the PDF · Esc to cancel"));

    boxQuote.replaceChildren();
    boxQuote.hidden = !attached;
    if (attached) {
      const remove = iconButton(doc, "close", "Detach this passage", () => {
        attached = null;
        scope = "document";
        renderComposer();
      });
      boxQuote.append(quoteBlock(attached, ""), remove);
    }

    pills.replaceChildren();
    pills.hidden = !attached;
    if (attached) {
      for (const prompt of getPrompts("passage")) {
        const pill = el(doc, "button", `k-pill${prompt.recommended ? "" : " k-custom"}`, prompt.label);
        setAutoDir(pill, prompt.label);
        pill.title = `${prompt.recommended ? "Recommended" : "Your prompt"} · click to use, ${ACCEL_CLICK} to send now\n\n${prompt.text}`;
        pill.addEventListener("click", (event: MouseEvent) => usePrompt(prompt, event.ctrlKey || event.metaKey));
        pills.append(pill);
      }
    }

    const passageDefault = getPassageDefault();
    input.placeholder = attached
      ? `Ask about this passage — or press Enter to ${passageDefault.label.toLowerCase()} it`
      : focusOn()
        ? "Ask a question; Konnash will pick the relevant sections…"
        : "Ask about this document…";
    syncInputDir();
    renderModelButton();
    const streaming = !!controller;
    sendButton.replaceChildren(icon(doc, streaming ? "stop" : "send"));
    sendButton.title = streaming ? "Stop (Esc)" : "Send (Enter)";
    sendButton.disabled = !streaming && !input.value.trim() && !attached;
  };

  /** The question box follows what is typed; empty, its placeholder */
  const syncInputDir = () => {
    const dir = chosenDir() || detectDirection(input.value) || detectDirection(input.placeholder) || interfaceDirection();
    if (input.dir !== dir) input.dir = dir;
  };

  const autoGrow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    renderComposer();
  };
  input.addEventListener("input", autoGrow);

  const openChat = (target: StoredChat, messageIndex?: number) => {
    controller?.abort();
    chat = target;
    openChatIDs.set(attachmentID, chat.id);
    renderBody();
    renderStream();
    if (messageIndex !== undefined) {
      const turn = stream.querySelector(`.k-turn[data-index="${messageIndex}"]`) as HTMLElement | null;
      if (turn) {
        turn.scrollIntoView({ block: "start" });
        turn.classList.add("k-flash");
        const passage = chat.messages[messageIndex]?.passage;
        const ref = passage && fromStoredRef(kdoc, passage);
        const span = ref && passageSpan(kdoc, ref);
        if (span) showSpan(span);
      }
    } else {
      body.scrollTop = body.scrollHeight;
    }
  };

  const toggleNotebook = (open = view !== "notebook") => {
    popovers.close();
    card.hide();
    view = open ? "notebook" : "chat";
    if (open) notebook.show();
    renderBody();
    if (!open) body.scrollTop = body.scrollHeight;
  };

  // Scope and suggestions ---------------------------------------------------------
  const startPicking = () => {
    const reader = getSelectedReader(win);
    if (!reader) return;
    try {
      startClickMode(reader, kdoc, () => {
        picking = false;
        forgetHighlight();
        if (!attached && scope === "passage") scope = "document";
        renderComposer();
      });
      picking = true;
      scope = "passage";
      forgetHighlight();
      renderComposer();
    } catch (e: any) {
      toast(doc, root, String(e?.message || e));
    }
  };
  const stopPicking = () => {
    const reader = getSelectedReader(win);
    if (reader && isClickModeOn(reader)) stopClickMode(reader);
    picking = false;
  };

  scopeButton.addEventListener("click", () => {
    const reader = getSelectedReader(win);
    const canPick = !!reader && isClickModeAvailable(reader);
    popovers.show(
      scopeButton,
      [
        {
          label: "Whole document",
          description: "The model reads the entire document.",
          icon: "document",
          selected: scope === "document" || (scope === "focus" && isFollowUp()),
          onSelect: () => {
            stopPicking();
            attached = null;
            scope = "document";
            renderComposer();
            input.focus();
          },
        },
        {
          label: "Most relevant sections",
          description: isFollowUp()
            ? "For a conversation's first question. Follow-ups read the whole document, so earlier answers stay in view. Start a new conversation (+) to focus a new question."
            : "Focus: a quick ranking picks the sections that matter. You'll see which, and why.",
          icon: "focus",
          selected: focusOn(),
          disabled: isFollowUp(),
          onSelect: () => {
            stopPicking();
            attached = null;
            scope = "focus";
            renderComposer();
            input.focus();
          },
        },
        {
          label: "A passage…",
          description: canPick
            ? "Click a paragraph in the PDF to ask about it."
            : "Select text or right-click a paragraph in the PDF.",
          icon: "passage",
          selected: scope === "passage",
          disabled: !canPick,
          onSelect: () => startPicking(),
        },
      ],
      "above",
    );
  });

  const usePrompt = (prompt: PromptDef, sendNow: boolean) => {
    inserted = prompt;
    input.value = prompt.text;
    if (sendNow) return submit();
    autoGrow();
    input.focus();
  };

  const openSuggestions = () => {
    const set = attached ? getPrompts("passage") : getPrompts("document");
    const entries: MenuEntry[] = set.map((prompt) => ({
      label: prompt.label,
      description: prompt.recommended ? "Recommended" : "Your prompt",
      icon: "sparkle",
      onSelect: (event: MouseEvent) => usePrompt(prompt, event.ctrlKey || event.metaKey),
    }));
    entries.push("separator", { label: "Edit suggestions…", icon: "settings", onSelect: () => openSettings() });
    popovers.show(suggestButton, entries, "above");
  };

  // Model ---------------------------------------------------------------------------
  // The provider's own list, in its own order: Konnash suggests no model
  const modelName = (settings: AISettings) => {
    if (!settings.preset.id) return "Choose a provider";
    if (!settings.model) return "Choose a model";
    return findCachedModel(settings.preset.id, settings.baseURL, settings.model)?.name || settings.model;
  };
  /** The effort shown with the model, when one is chosen */
  const effortLabel = (settings: AISettings) =>
    effortLevels(settings.preset, settings.model).find((l) => l.value === settings.effort)?.label || "";
  const renderModelButton = () => {
    const settings = getSettings();
    const name = modelName(settings);
    const effort = effortLabel(settings);
    const label = effort ? `${name} · ${effort.toLowerCase()}` : name;
    modelButton.replaceChildren(el(doc, "span", "k-scope-label", label), icon(doc, "chevronDown", "k-icon k-chev"));
    modelButton.title = settings.preset.id
      ? `${settings.preset.label} · ${name}${effort ? ` · effort: ${effort}` : ""}`
      : "Choose an AI provider in Konnash settings";
    modelButton.setAttribute("aria-label", `Model: ${label}`);
  };
  /** Effort, under the models: the provider's own levels, or its default */
  const effortRow = () => {
    const settings = getSettings();
    const levels = effortLevels(settings.preset, settings.model);
    if (!levels.length) return null;
    const row = el(doc, "div", "k-menu-row");
    const seg = el(doc, "div", "k-dirseg");
    // Anthropic always has a level; elsewhere "Default" leaves it to the provider
    const choices = settings.preset.id === "anthropic" ? levels : [{ value: "", label: "Default" }, ...levels];
    const render = () => {
      const current = getSettings().effort;
      seg.replaceChildren();
      for (const level of choices) {
        const b = el(doc, "button", level.value === current ? "k-selected" : undefined, level.label);
        b.title = level.value
          ? `How much ${settings.preset.label} thinks before answering: ${level.label.toLowerCase()}`
          : `${settings.preset.label} decides`;
        b.setAttribute("aria-pressed", String(level.value === current));
        b.addEventListener("click", () => {
          setEffort(settings.preset, level.value);
          render();
          renderModelButton();
        });
        seg.append(b);
      }
    };
    render();
    row.append(el(doc, "span", "k-menu-label", "Effort"), seg);
    return row;
  };
  const openModelMenu = () => {
    const settings = getSettings();
    if (!settings.preset.id) return openSettings();
    const models = getCachedModels(settings.preset.id, settings.baseURL)?.models || [];
    const list = el(doc, "div", "k-model-list");
    const rows: HTMLElement[] = [];
    for (const m of models) {
      const selected = m.id === settings.model;
      const row = el(doc, "button", `k-menu-item${selected ? " k-selected" : ""}`);
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(selected));
      row.append(selected ? icon(doc, "check") : el(doc, "span", "k-icon-space"));
      const text = el(doc, "span", "k-menu-text");
      text.append(el(doc, "span", "k-menu-label", m.name));
      const details = [m.name !== m.id ? m.id : "", formatContext(m.contextWindow)].filter(Boolean).join(" · ");
      if (details) text.append(el(doc, "span", "k-menu-desc", details));
      row.append(text);
      row.dataset.find = `${m.name} ${m.id}`.toLowerCase();
      row.addEventListener("click", () => {
        popovers.close();
        setPref("model", m.id);
        renderComposer();
        input.focus();
      });
      rows.push(row);
    }
    const entries: MenuEntry[] = [];
    let find: HTMLInputElement | null = null;
    if (rows.length > 10) {
      // Long lists (OpenRouter lists hundreds): type to narrow them
      find = el(doc, "input", "k-menu-find");
      find.type = "search";
      find.placeholder = "Find a model…";
      find.dir = "auto";
      find.addEventListener("input", () => {
        const q = find!.value.trim().toLowerCase();
        for (const row of rows) row.hidden = !!q && !row.dataset.find!.includes(q);
      });
      find.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") rows.find((r) => !r.hidden)?.click();
      });
      entries.push(find);
    }
    list.append(...rows);
    if (rows.length) entries.push(list);
    else entries.push(el(doc, "div", "k-menu-status", `No model list from ${settings.preset.label} yet.`));
    const effort = effortRow();
    if (effort) entries.push("separator", effort);
    entries.push(
      "separator",
      {
        label: rows.length ? "Refresh the list" : "Load the list",
        icon: "restore",
        onSelect: async () => {
          try {
            await fetchModels(getSettings());
            renderComposer();
            openModelMenu();
          } catch (e: any) {
            toast(doc, root, String(e?.message || e));
          }
        },
      },
      { label: "Model settings…", icon: "settings", onSelect: () => openSettings() },
    );
    popovers.show(modelButton, entries, "above");
    if (find) find.focus();
    else list.querySelector<HTMLElement>(".k-selected")?.scrollIntoView({ block: "nearest" });
  };
  modelButton.addEventListener("click", () => openModelMenu());
  // Settings changed elsewhere (Settings → Konnash): show the model in use
  const prefObservers = ["provider", "model", "baseURL", "modelCache", "effort", "providerEffort"].map((key) =>
    Zotero.Prefs.registerObserver(`${config.prefsPrefix}.${key}`, () => renderModelButton(), true),
  );

  // ⋯ menu ---------------------------------------------------------------------------
  const openMoreMenu = () => {
    const settings = getSettings();
    const status = el(doc, "div", "k-menu-status", settings.preset.id ? `${settings.preset.label} · ${modelName(settings)}` : "No AI provider chosen yet");
    const sizeRow = el(doc, "div", "k-menu-row");
    const sizeValue = el(doc, "span", "k-size", String(fontSize()));
    const setSize = (delta: number) => {
      setPref("fontSize", Math.min(MAX_FONT, Math.max(MIN_FONT, fontSize() + delta)));
      applyFontSize();
      sizeValue.textContent = String(fontSize());
    };
    const minus = el(doc, "button", "k-iconbtn", "−");
    minus.title = "Smaller text";
    minus.addEventListener("click", () => setSize(-1));
    const plus = el(doc, "button", "k-iconbtn", "+");
    plus.title = "Larger text";
    plus.addEventListener("click", () => setSize(1));
    sizeRow.append(el(doc, "span", "k-menu-label", "Text size"), minus, sizeValue, plus);
    const dirRow = el(doc, "div", "k-menu-row");
    const dirSeg = el(doc, "div", "k-dirseg");
    const dirChoices: [DirSetting, string, string][] = [
      ["auto", "Auto", "Each paragraph reads in the direction of its own language"],
      ["rtl", "RTL", "Every answer and question right-to-left"],
      ["ltr", "LTR", "Every answer and question left-to-right"],
    ];
    const renderDirSeg = () => {
      const current = chosenDir() || "auto";
      dirSeg.replaceChildren();
      for (const [value, label, hint] of dirChoices) {
        const b = el(doc, "button", value === current ? "k-selected" : undefined, label);
        b.title = hint;
        b.setAttribute("aria-pressed", String(value === current));
        b.addEventListener("click", () => {
          setPref("textDirection", value);
          renderDirSeg();
          renderStream();
          renderComposer();
        });
        dirSeg.append(b);
      }
    };
    renderDirSeg();
    dirRow.append(el(doc, "span", "k-menu-label", "Text direction"), dirSeg);
    popovers.show(moreButton, [
      status,
      "separator",
      sizeRow,
      dirRow,
      "separator",
      {
        label: "Rename conversation",
        icon: "edit",
        disabled: view !== "chat" || !chat.messages.length,
        onSelect: () => renameChat(),
      },
      {
        label: "Add conversation to note…",
        icon: "note",
        disabled: !chat.messages.length,
        onSelect: () => chooseNote({ anchor: moreButton, placement: "below" }, conversationNoteHTML(kdoc, chat, noteLinks())),
      },
      {
        label: `Trash${file.trash.length ? ` (${file.trash.length})` : ""}`,
        icon: "trash",
        onSelect: () => {
          view = "notebook";
          notebook.show("chats", true);
          renderBody();
        },
      },
      "separator",
      { label: "Settings…", icon: "settings", onSelect: () => openSettings() },
    ]);
  };

  // Sending -------------------------------------------------------------------------
  const submit = () => {
    if (controller) return;
    const typed = input.value.trim();
    const label = inserted && typed === inserted.text.trim() ? inserted.label : undefined;
    inserted = null;
    if (scope === "passage" && attached) {
      const fallback = getPassageDefault();
      const ref = attached;
      attached = null;
      scope = "document";
      input.value = "";
      autoGrow();
      sendTurn({ text: typed || fallback.text, label: typed ? label : fallback.label, passage: ref });
      return;
    }
    if (!typed) return;
    input.value = "";
    autoGrow();
    sendTurn({ text: typed, label, focus: focusOn() });
  };

  // Sending the document -------------------------------------------------------------
  // Before the first question ever sent, the reader is told what leaves the
  // computer and that the right to send a document is theirs to have. An
  // item tagged "no-ai" gets a warning they can close; it never blocks.
  const showDisclosure = (providerLabel: string, onAccept: () => void, onDecline: () => void) => {
    notices.querySelector(".k-notice-first")?.remove();
    const notice = el(doc, "div", "k-notice k-notice-first");
    notice.setAttribute("role", "alertdialog");
    notice.append(
      el(doc, "div", "k-notice-title", "Before your first question"),
      el(
        doc,
        "div",
        "k-notice-text",
        `To answer, Konnash sends the text of the document you are reading and your question to ${providerLabel}, with your key. Some publishers and subscriptions do not allow their documents to be sent to AI services. Whether you may send a document is for you to check, and the choice to send it is yours.`,
      ),
    );
    const actions = el(doc, "div", "k-notice-actions");
    const accept = el(doc, "button", "k-notice-primary", "I understand");
    const later = el(doc, "button", "k-text-btn", "Not now");
    accept.addEventListener("click", () => {
      setPref("disclosureAccepted", true);
      notice.remove();
      onAccept();
    });
    later.addEventListener("click", () => {
      notice.remove();
      onDecline();
    });
    actions.append(accept, later);
    notice.append(actions);
    notices.append(notice);
    accept.focus();
  };
  const isTaggedNoAI = () => {
    const items = [attachment, attachment.parentItem].filter(Boolean) as Zotero.Item[];
    return items.some((item) => item.getTags().some((t: { tag: string }) => /^no[\s_-]?ai$/i.test(t.tag.trim())));
  };
  const showNoAIWarning = () => {
    if (noAIWarned.has(attachmentID) || notices.querySelector(".k-notice-noai") || !isTaggedNoAI()) return;
    const notice = el(doc, "div", "k-notice k-notice-noai");
    notice.setAttribute("role", "status");
    const close = el(doc, "button", "k-notice-close", "×");
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => {
      noAIWarned.add(attachmentID);
      notice.remove();
    });
    notice.append(
      close,
      el(doc, "div", "k-notice-title", "Tagged “no-ai”"),
      el(
        doc,
        "div",
        "k-notice-text",
        "This item is marked as one that should not be sent to AI services, for example because its licence does not allow it. Asking about it sends its text to your provider; if you continue, that is your choice.",
      ),
    );
    notices.prepend(notice);
  };

  const sendTurn = async (turn: { text: string; label?: string; passage?: PassageRef; focus?: boolean }) => {
    if (controller) return;
    popovers.close();
    view = "chat";
    renderBody();
    const settings = getSettings();
    renderBanner();
    if (getSettingsProblem(settings)) return;
    showNoAIWarning();
    if (!getPref("disclosureAccepted")) {
      showDisclosure(
        settings.preset.label,
        () => sendTurn(turn),
        () => {
          // Keep what was typed, so nothing is lost
          if (!input.value.trim()) input.value = turn.text;
        },
      );
      return;
    }
    const mode = settings.preset.protocol === "anthropic" ? "native" : "protocol";

    // Earlier turns (passage questions rebuilt with their passage)
    const history: ChatTurn[] = [];
    for (let i = 0; i + 1 < chat.messages.length; i += 2) {
      const [q, a] = [chat.messages[i], chat.messages[i + 1]];
      if (q.role !== "user" || a.role !== "assistant" || !a.text || a.error) continue;
      const ref = q.passage && fromStoredRef(kdoc, q.passage);
      history.push({ role: "user", text: ref ? buildPassageQuestion(kdoc, ref, q.text, mode) : q.text }, { role: "assistant", text: a.text });
    }
    if (!chat.messages.length) {
      chat.title = turn.passage
        ? `${turn.label || chatTitleFrom(turn.text)} · ${describePassage(kdoc, turn.passage).label}`
        : chatTitleFrom(turn.label || turn.text);
    }
    if (!file.chats.includes(chat)) file.chats.unshift(chat);
    openChatIDs.set(attachmentID, chat.id);

    const now = Date.now();
    chat.messages.push({ role: "user", text: turn.text, label: turn.label, passage: turn.passage ? toStoredRef(kdoc, turn.passage) : undefined, time: now });
    const answer: StoredMessage = { role: "assistant", text: "", time: now };
    chat.messages.push(answer);
    if (turn.passage) notifyAsked();
    renderStream();
    renderHeader();
    const turnIndex = chat.messages.length - 2;
    const turnEl = stream.lastElementChild as HTMLElement;
    turnEl.scrollIntoView({ block: "start" });

    let answerEl = turnEl.querySelector(".k-a") as HTMLElement;
    let scheduled = false;
    const refresh = (status?: string) => {
      scheduled = false;
      if (!turnEl.isConnected) return;
      // Stay with the answer as it grows only if the reader was already at its end
      const following = isAtEnd();
      const fresh = renderAnswerBody(answer, false, true, status, answerEl);
      answerEl.replaceWith(fresh);
      answerEl = fresh;
      if (following) body.scrollTop = body.scrollHeight;
      renderMoreBelow(true);
    };
    const schedule = () => {
      if (!scheduled) {
        scheduled = true;
        win.setTimeout(() => refresh(), 80);
      }
    };

    controller = new (win as any).AbortController() as AbortController;
    renderComposer();
    try {
      let selection: number[] | undefined;
      let partialNote: string | undefined;
      if (turn.passage) {
        // A document too big to send whole: route by the passage itself
        const fits = estimateTokens(kdoc) <= Math.floor(settings.contextWindow * 0.7) - 8000;
        if (!fits) {
          const route = await decideRoute({ doc: kdoc, question: describePassage(kdoc, turn.passage).text, settings, file, focus: true, signal: controller.signal });
          answer.routing = route.routing;
          // The passage itself, and what it points to (named in the question)
          const passageAndLinks = withLinkedParagraphs(kdoc, kdoc.paragraphs[turn.passage.paragraph].sentences, 3000).selection;
          selection = route.selection && [...new Set([...route.selection, ...passageAndLinks])].sort((x, y) => x - y);
          partialNote = route.partialNote;
        }
      } else {
        const useFocus = !!turn.focus && !history.length;
        if (useFocus) refresh("Choosing the relevant sections");
        const route = await decideRoute({ doc: kdoc, question: turn.text, settings, file, focus: useFocus, signal: controller.signal });
        // Follow-ups reuse the whole (cached) document unless it is too big
        const partial = !history.length || route.routing.mode === "large";
        if (partial) {
          answer.routing = route.routing;
          selection = route.selection;
          partialNote = route.partialNote;
        }
      }
      const context = renderContextLine(doc, answer.routing, showSection);
      if (context) turnEl.insertBefore(context, answerEl);
      refresh();
      const result = await ask({
        doc: kdoc,
        title,
        source,
        history,
        question: turn.passage ? buildPassageQuestion(kdoc, turn.passage, turn.text, mode) : turn.text,
        settings,
        signal: controller.signal,
        selection,
        partialNote,
        onThinking: (text) => {
          answer.thinking = text;
          schedule();
        },
        onUpdate: (text) => {
          answer.text = text;
          schedule();
        },
      });
      answer.text = result.text;
      answer.thinking = result.thinking;
      answer.thinkingMs = result.thinkingMs;
      if (result.refusal) answer.error = result.refusal;
      answer.meta = [
        result.fallbackModel ? `answered by ${result.fallbackModel}` : result.model,
        ...(result.truncated ? ["cut off at the length limit"] : []),
      ];
    } catch (e: any) {
      answer.error = String(e?.message || e);
      if (answer.text) answer.meta = [settings.model];
    } finally {
      controller = null;
      chat.updated = Date.now();
      persist();
      // Re-render this turn in its final form, keeping the reader's place
      if (turnEl.isConnected) turnEl.replaceWith(renderTurn(turnIndex));
      renderMoreBelow(false);
      renderComposer();
    }
  };

  const retryLast = () => {
    const last = chat.messages[chat.messages.length - 1];
    const question = chat.messages[chat.messages.length - 2];
    if (last?.role !== "assistant" || question?.role !== "user") return;
    chat.messages.splice(-2, 2);
    const ref = question.passage ? fromStoredRef(kdoc, question.passage) : null;
    renderStream();
    sendTurn({ text: question.text, label: question.label, passage: ref || undefined });
  };

  sendButton.addEventListener("click", () => {
    if (controller) controller.abort();
    else submit();
  });
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    // Enter that confirms an input method's text (macOS and Windows IMEs)
    // is not a send
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      if (controller || picking || attached) event.preventDefault();
      if (controller) controller.abort();
      else if (picking) stopPicking();
      else if (attached) {
        attached = null;
        scope = "document";
      }
      renderComposer();
    }
  });
  input.addEventListener("focus", renderBanner);
  // Clicking into the question box to write: the highlight has done its job
  input.addEventListener("pointerdown", () => {
    if (highlighted) clearPDFHighlight();
  });

  // Picked passages from the PDF (Pick, right-click, selection) -------------------
  const attach = (ref: PassageRef) => {
    attached = ref;
    scope = "passage";
    picking = false;
    inserted = null;
    view = "chat";
    renderBody();
    renderComposer();
    const span = passageSpan(kdoc, ref);
    if (span) showSpan(span);
    input.focus();
  };

  const pick = (target: ExplainTarget, mode: PickMode) => {
    if (!loaded) {
      waiting.push({ target, mode });
      return;
    }
    if (mode === "now") {
      const prompt = getPassageDefault();
      sendTurn({ text: prompt.text, label: prompt.label, passage: target });
    } else {
      attach(target);
    }
  };

  // Start -----------------------------------------------------------------------------
  if (hasKonnashHighlight(thisReader())) {
    highlighted = { span: null };
    watchPDF();
  }
  renderHighlightChip();
  renderBanner();
  showNoAIWarning();
  renderBody();
  renderStream();
  renderComposer();
  loadDoc(attachment).then((loadedFile) => {
    file = loadedFile;
    loaded = true;
    // The document's fingerprint travels with its conversations, so they
    // can be brought to another computer where Zotero gave it another key
    const basis = documentBasis(kdoc);
    if (file.basis !== basis) {
      file.basis = basis;
      if (file.chats.length || file.trash.length) persist();
    }
    const wanted = openChatIDs.get(attachmentID);
    const existing = file.chats.find((c) => c.id === wanted);
    if (existing) openChat(existing);
    else if (!chat.messages.length && wanted === undefined && file.chats.length) {
      // Reopen the most recent conversation the first time this PDF is shown
      openChat([...file.chats].sort((a, b) => b.updated - a.updated)[0]);
    }
    notifyAsked();
    for (const w of waiting.splice(0)) pick(w.target, w.mode);
  });

  return {
    root,
    pick,
    dispose: () => {
      observer.disconnect();
      prefObservers.forEach((symbol) => Zotero.Prefs.unregisterObserver(symbol));
      popovers.dispose();
      stopPicking();
      stopWatchingPDF?.();
    },
  };
}
