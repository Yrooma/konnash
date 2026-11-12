/**
 * Notebook: everything asked about this PDF, three ways.
 * - Contents: the paper's sections, how much you've asked about each; open
 *   one to see its numbered sentences (and check citations)
 * - Passages: every passage you asked about, in reading order
 * - Chats: conversations by date, with Trash
 */
import { getPageLabel, KonnashDocument } from "./document";
import { CitationSpan, parseCitation } from "./citations";
import { DocFile, deleteForever, restoreFromTrash, trashChat } from "./docStore";
import { getSections, sectionLabel } from "./structure";
import { pagesLabel } from "./router";
import { indexPassages, passageMeta, sectionActivity } from "./passages";
import { describePassage } from "./ai/prompt";
import { editInPlace, el, icon, iconButton, toast } from "./ui";
import { documentDirection, setAutoDir } from "./bidi";

export type NotebookTab = "contents" | "passages" | "chats";

export interface NotebookOptions {
  kdoc: KonnashDocument;
  getFile: () => DocFile;
  save: () => void;
  currentChatID: () => string | null;
  openChat: (chatID: string, messageIndex?: number) => void;
  showSpan: (span: CitationSpan) => void;
  showSection: (sectionID: string) => void;
  /** Conversations changed (deleted or restored) */
  onChange: () => void;
}

function timeAgo(time: number) {
  if (!time) return "";
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days < 1) return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return `${days} d ago`;
  return new Date(time).toLocaleDateString();
}

export function createNotebookView(doc: Document, panelRoot: HTMLElement, options: NotebookOptions) {
  const { kdoc } = options;
  const docDir = documentDirection(kdoc);
  const root = el(doc, "div", "k-notebook");
  const seg = el(doc, "div", "k-seg");
  seg.setAttribute("role", "tablist");
  const content = el(doc, "div");
  root.append(seg, content);
  let tab: NotebookTab = "contents";
  let showTrash = false;
  const expanded = new Set<string>();

  const tabs: [NotebookTab, string][] = [
    ["contents", "Contents"],
    ["passages", "Passages"],
    ["chats", "Chats"],
  ];
  const renderSeg = () => {
    seg.replaceChildren();
    for (const [id, label] of tabs) {
      const b = el(doc, "button", id === tab ? "k-selected" : undefined, label);
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => {
        tab = id;
        showTrash = false;
        render();
      });
      seg.append(b);
    }
  };

  const empty = (text: string) => el(doc, "div", "k-empty-small", text);

  // Contents --------------------------------------------------------------------------
  const renderContents = () => {
    const activity = sectionActivity(kdoc, options.getFile());
    const list = el(doc, "div", "k-list");
    for (const s of getSections(kdoc)) {
      const row = el(doc, "div", `k-row${s.level ? " k-level-1" : ""}`);
      const toggle = iconButton(doc, expanded.has(s.id) ? "chevronDown" : "chevronRight", "Show numbered sentences", (event) => {
        event.stopPropagation();
        if (expanded.has(s.id)) expanded.delete(s.id);
        else expanded.add(s.id);
        render();
      });
      toggle.style.opacity = "1";
      const main = el(doc, "div", "k-row-main");
      // The document's heading, or Konnash's description set apart
      const label = sectionLabel(kdoc, s);
      const title = el(doc, "div", "k-row-title");
      setAutoDir(title, label.text, docDir);
      title.title = label.text;
      title.append(el(doc, "span", label.own ? "k-untitled" : undefined, label.text));
      // The role only when the heading doesn't already say it ("Abstract")
      const role = s.role?.replace("-", " ");
      if (role && !label.text.toLowerCase().includes(role.split(" ")[0])) title.append(el(doc, "span", "k-role", role));
      main.append(title, el(doc, "div", "k-row-meta", pagesLabel(kdoc, s.pages)));
      const side = el(doc, "div", "k-row-side");
      const n = activity.get(s.id) || 0;
      if (n) {
        const count = el(doc, "span", "k-count", String(n));
        count.title = `Asked about ${n} time${n === 1 ? "" : "s"}`;
        side.append(count);
      }
      row.append(toggle, main, side);
      row.title = "Show this section in the PDF";
      row.addEventListener("click", () => options.showSection(s.id));
      list.append(row);
      if (expanded.has(s.id)) {
        const box = el(doc, "div", "k-sentences");
        for (let p = s.start; p <= s.end; p++) {
          const paragraph = kdoc.paragraphs[p];
          const para = el(doc, "div");
          para.style.marginBottom = "6px";
          setAutoDir(para, paragraph.sentences.map((i) => kdoc.sentences[i].text).join(" "), docDir, 3);
          for (const i of paragraph.sentences) {
            const sentence = kdoc.sentences[i];
            const span = el(doc, "span", "k-sentence");
            span.append(el(doc, "span", "k-sid", sentence.id), doc.createTextNode(`${sentence.text} `));
            span.addEventListener("click", () => {
              const cite = parseCitation(kdoc, sentence.id).spans[0];
              if (cite) options.showSpan(cite);
            });
            para.append(span);
          }
          box.append(para);
        }
        list.append(box);
      }
    }
    content.append(list);
    if (!getSections(kdoc).length) content.append(empty("This PDF has no readable text structure."));
  };

  // Passages --------------------------------------------------------------------------
  const renderPassages = () => {
    const entries = indexPassages(kdoc, options.getFile());
    if (!entries.length) {
      content.append(
        empty("Questions you ask about a passage appear here in reading order. Choose “A passage…” in the question box, or select text or right-click a paragraph in the PDF."),
      );
      return;
    }
    const list = el(doc, "div", "k-list");
    for (const entry of entries) {
      const row = el(doc, "div", "k-row");
      const main = el(doc, "div", "k-row-main");
      const meta = entry.ref ? passageMeta(kdoc, entry.ref) : `${entry.stored.anchor.pid} (not found in this version)`;
      main.append(el(doc, "div", "k-row-meta", meta));
      const snippet = entry.ref ? describePassage(kdoc, entry.ref).text : entry.stored.anchor.start;
      const snippetEl = el(doc, "div", "k-row-snippet", `“${snippet}”`);
      setAutoDir(snippetEl, snippet, docDir, 3);
      const asked = entry.asked.length > 80 ? `${entry.asked.slice(0, 80)}…` : entry.asked;
      const askedEl = el(doc, "div", "k-row-title", asked);
      setAutoDir(askedEl);
      main.append(snippetEl, askedEl);
      row.append(main, el(doc, "div", "k-row-side", timeAgo(entry.time)));
      row.title = "Open this question";
      row.addEventListener("click", () => options.openChat(entry.chatID, entry.messageIndex));
      list.append(row);
    }
    content.append(list);
  };

  // Chats ---------------------------------------------------------------------------
  const renderChats = () => {
    const file = options.getFile();
    if (showTrash) {
      const back = el(doc, "button", "k-text-btn", "← Back to chats");
      back.addEventListener("click", () => {
        showTrash = false;
        render();
      });
      content.append(back, el(doc, "div", "k-section-label", "Trash · kept for 30 days"));
      if (!file.trash.length) {
        content.append(empty("Trash is empty."));
        return;
      }
      const list = el(doc, "div", "k-list");
      for (const item of file.trash) {
        const row = el(doc, "div", "k-row");
        const main = el(doc, "div", "k-row-main");
        const title = el(doc, "div", "k-row-title", item.chat.title);
        setAutoDir(title);
        main.append(title, el(doc, "div", "k-row-meta", `Deleted ${timeAgo(item.deletedAt)}`));
        const side = el(doc, "div", "k-row-side");
        side.append(
          iconButton(doc, "restore", "Restore", (event) => {
            event.stopPropagation();
            restoreFromTrash(file, item);
            options.save();
            options.onChange();
            render();
          }),
          iconButton(doc, "close", "Delete forever", (event) => {
            event.stopPropagation();
            deleteForever(file, item);
            options.save();
            render();
          }),
        );
        row.append(main, side);
        list.append(row);
      }
      content.append(list);
      return;
    }
    const chats = file.chats.filter((c) => c.messages.length).sort((a, b) => b.updated - a.updated);
    if (!chats.length) content.append(empty("No conversations yet."));
    const list = el(doc, "div", "k-list");
    for (const chat of chats) {
      const row = el(doc, "div", "k-row");
      const main = el(doc, "div", "k-row-main");
      const questions = chat.messages.filter((m) => m.role === "user").length;
      const title = el(doc, "div", "k-row-title", chat.title);
      setAutoDir(title);
      title.title = chat.title;
      if (chat.id === options.currentChatID()) title.style.color = "var(--k-accent)";
      main.append(title, el(doc, "div", "k-row-meta", `${timeAgo(chat.updated)} · ${questions} question${questions === 1 ? "" : "s"}`));
      const rename = () =>
        editInPlace(doc, title, chat.title, (name) => {
          if (name) {
            chat.title = name;
            options.save();
            options.onChange();
          }
          render();
        });
      title.addEventListener("dblclick", (event: MouseEvent) => {
        event.stopPropagation();
        rename();
      });
      const side = el(doc, "div", "k-row-side");
      side.append(
        iconButton(doc, "edit", "Rename", (event) => {
          event.stopPropagation();
          rename();
        }),
        iconButton(doc, "trash", "Move to Trash", (event) => {
          event.stopPropagation();
          trashChat(file, chat);
          options.save();
          options.onChange();
          render();
          toast(doc, panelRoot, "Conversation moved to Trash.", {
            label: "Undo",
            run: () => {
              const item = file.trash.find((t) => t.chat === chat);
              if (item) restoreFromTrash(file, item);
              options.save();
              options.onChange();
              render();
            },
          });
        }),
      );
      row.append(main, side);
      row.addEventListener("click", () => options.openChat(chat.id));
      list.append(row);
    }
    content.append(list);
    const trashLink = el(doc, "button", "k-text-btn");
    trashLink.append(icon(doc, "trash"));
    trashLink.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin:12px 6px 0;";
    trashLink.append(doc.createTextNode(`Trash${file.trash.length ? ` (${file.trash.length})` : ""}`));
    trashLink.addEventListener("click", () => {
      showTrash = true;
      render();
    });
    content.append(trashLink);
  };

  const render = () => {
    renderSeg();
    content.replaceChildren();
    if (tab === "contents") renderContents();
    else if (tab === "passages") renderPassages();
    else renderChats();
  };

  return {
    root,
    show: (which?: NotebookTab, trash = false) => {
      if (which) tab = which;
      showTrash = trash;
      render();
    },
    refresh: render,
    pageLabel: (pageIndex: number) => getPageLabel(kdoc, pageIndex),
  };
}
