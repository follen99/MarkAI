(function () {
  const cfg = window.MARKAI;
  const docPane = document.getElementById("doc-pane");
  const outlineList = document.getElementById("outline-list");
  const noteListEl = document.getElementById("note-list");
  const viewerMain = document.getElementById("viewer-main");

  let notesById = {};
  let pdfDoc = null;
  let pdfScale = 1.2;
  let pdfOutlineFlat = []; // [{level, title, page, id}]
  let activeHighlight = null;
  let activeHighlightPosition = null;
  let pdfRenderToken = 0;
  let selectionMode = false;
  let lastHandledSelectionKey = null;
  const selectedNoteIds = new Set();
  const usedMarkerTops = new WeakMap();

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  document.querySelectorAll(".sidebar-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(btn.dataset.toggle);
      if (panel) panel.classList.toggle("collapsed");
    });
  });

  function avoidMarkerCollision(container, top) {
    const used = usedMarkerTops.get(container) || [];
    let candidate = top;
    while (used.some((t) => Math.abs(t - candidate) < 12)) {
      candidate += 14;
    }
    used.push(candidate);
    usedMarkerTops.set(container, used);
    return candidate;
  }

  function shortWords(text, n, fromEnd) {
    const words = (text || "").trim().split(/\s+/).filter(Boolean);
    return (fromEnd ? words.slice(-n) : words.slice(0, n)).join(" ");
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Scrolls #viewer-main (the real scroll container for both md/docx and pdf
  // content) so rectOrEl is centered, instantly. Reading getBoundingClientRect
  // right after this reflects the new position — unlike a smooth scrollIntoView,
  // which is asynchronous and leaves stale rects for anything read immediately
  // after (that staleness was why popovers used to land at the pre-scroll spot).
  function scrollIntoViewerCenter(rectOrEl) {
    const containerRect = viewerMain.getBoundingClientRect();
    const rect = rectOrEl instanceof Element ? rectOrEl.getBoundingClientRect() : rectOrEl;
    const targetMid = rect.top + rect.height / 2;
    const containerMid = containerRect.top + containerRect.height / 2;
    const delta = targetMid - containerMid;
    const maxScroll = Math.max(0, viewerMain.scrollHeight - viewerMain.clientHeight);
    viewerMain.scrollTop = clamp(viewerMain.scrollTop + delta, 0, maxScroll);
  }

  function showToast(msg) {
    let toast = document.querySelector(".mk-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "mk-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add("visible");
    clearTimeout(toast._mkTimer);
    toast._mkTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
  }

  // ---------- Notes API ----------

  async function fetchNotes() {
    const res = await fetch(cfg.notesUrl);
    const data = await res.json();
    notesById = {};
    data.notes.forEach((n) => (notesById[n.id] = n));
    return data.notes;
  }

  async function createNote(noteText, position) {
    const res = await fetch(cfg.notesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: noteText, position }),
    });
    if (!res.ok) throw new Error("Could not save note");
    return (await res.json()).note;
  }

  async function updateNote(id, patch) {
    const res = await fetch(`/notes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error("Could not update note");
    return (await res.json()).note;
  }

  async function deleteNoteApi(id) {
    await fetch(`/notes/${id}`, { method: "DELETE" });
  }

  async function bulkNotesApi(ids, action) {
    const res = await fetch(`/documents/${cfg.documentId}/notes/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action }),
    });
    if (!res.ok) throw new Error("Bulk action failed");
    return (await res.json()).notes;
  }

  // ---------- Highlighting the exact spot a note refers to ----------

  function clearHighlight() {
    if (activeHighlight) {
      activeHighlight.clear();
      activeHighlight = null;
    }
    activeHighlightPosition = null;
  }

  function highlightPosition(position, opts) {
    clearHighlight();
    const scroll = !opts || opts.scroll !== false;
    activeHighlightPosition = position;
    activeHighlight = cfg.docType === "pdf" ? highlightPdfPosition(position, scroll) : highlightBlockPosition(position, scroll);
    return activeHighlight;
  }

  function findBlockForPosition(position) {
    if (cfg.docType === "docx") {
      return docPane.querySelector(`.doc-block[data-paragraph-index="${position.paragraph_index}"]`);
    }
    return docPane.querySelector(`.doc-block[data-line="${position.line_number}"]`);
  }

  function rangeAtOffset(container, start, end) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let total = 0;
    let startNode = null;
    let startOff = 0;
    let endNode = null;
    let endOff = 0;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.textContent.length;
      if (startNode === null && start <= total + len) {
        startNode = n;
        startOff = Math.max(0, start - total);
      }
      if (end <= total + len) {
        endNode = n;
        endOff = Math.max(0, end - total);
        break;
      }
      total += len;
    }
    if (!startNode) return null;
    if (!endNode) {
      endNode = startNode;
      endOff = startNode.textContent.length;
    }
    try {
      const range = document.createRange();
      range.setStart(startNode, Math.min(startOff, startNode.textContent.length));
      range.setEnd(endNode, Math.min(endOff, endNode.textContent.length));
      return range;
    } catch (e) {
      return null;
    }
  }

  // Prefer the offset captured at creation time, but fall back to searching
  // the current text for the quoted phrase / word so highlighting still
  // works for older notes (or if the document text shifted).
  function locateAnchorInBlock(block, position) {
    if (position.char_offset != null) {
      const length = position.char_length || (position.selected_text ? position.selected_text.length : 1);
      return { start: position.char_offset, length: Math.max(length, 1) };
    }
    const text = block.textContent;
    const target = position.selected_text || position.anchor_text;
    if (target) {
      const idx = text.indexOf(target);
      if (idx >= 0) return { start: idx, length: target.length };
    }
    return null;
  }

  function getAnchorRectInBlock(block, position) {
    const anchor = locateAnchorInBlock(block, position);
    if (!anchor) return null;
    const range = rangeAtOffset(block, anchor.start, anchor.start + anchor.length);
    if (!range) return null;
    const rects = range.getClientRects();
    return rects.length ? rects[0] : range.getBoundingClientRect();
  }

  function highlightBlockPosition(position, scroll) {
    const block = findBlockForPosition(position);
    if (!block) return null;
    block.classList.add("note-target-block");
    let markEl = null;

    const anchor = locateAnchorInBlock(block, position);
    if (anchor) {
      const range = rangeAtOffset(block, anchor.start, anchor.start + anchor.length);
      if (range) {
        try {
          markEl = document.createElement("mark");
          markEl.className = "note-highlight";
          range.surroundContents(markEl);
        } catch (err) {
          markEl = null;
        }
      }
    }

    if (scroll) scrollIntoViewerCenter(block);

    return {
      clear() {
        block.classList.remove("note-target-block");
        if (markEl && markEl.parentNode) {
          const parent = markEl.parentNode;
          while (markEl.firstChild) parent.insertBefore(markEl.firstChild, markEl);
          parent.removeChild(markEl);
          parent.normalize();
        }
      },
      anchorRect() {
        return (markEl || block).getBoundingClientRect();
      },
    };
  }

  // ---------- Popover ----------

  function closePopover() {
    const existing = document.querySelector(".popover");
    if (existing) existing.remove();
    clearHighlight();
    lastHandledSelectionKey = null;
  }

  function openCreatePopover(x, y, position) {
    closePopover();
    highlightPosition(position, { scroll: false });

    const pop = document.createElement("div");
    pop.className = "popover";
    const contextPreview = [position.context_before, position.selected_text ? `» ${position.selected_text} «` : "", position.context_after]
      .filter(Boolean)
      .join(" ");
    pop.innerHTML = `
      <div class="popover-context">${escapeHtml(contextPreview) || "<em>No surrounding text captured.</em>"}</div>
      <textarea placeholder="Write your note…" autofocus></textarea>
      <div class="popover-actions">
        <button class="btn secondary small" data-action="cancel">Cancel</button>
        <button class="btn small" data-action="save">Add note</button>
      </div>
    `;
    document.body.appendChild(pop);
    positionPopover(pop, x, y);
    pop.querySelector("textarea").focus();

    pop.querySelector('[data-action="cancel"]').addEventListener("click", closePopover);
    pop.querySelector('[data-action="save"]').addEventListener("click", async () => {
      const text = pop.querySelector("textarea").value.trim();
      if (!text) return;
      try {
        const note = await createNote(text, position);
        notesById[note.id] = note;
        closePopover();
        placeMarkerForNote(note);
        renderNoteList(Object.values(notesById));
      } catch (e) {
        alert(e.message);
      }
    });
  }

  // opts: {x, y} to position explicitly (e.g. next to the clicked marker), or
  // {scroll: true} to scroll the highlight into view and derive x/y from where
  // it actually landed once scrolled (this is what makes "open from list" work).
  function openEditPopover(note, opts) {
    closePopover();
    const highlight = highlightPosition(note.position, { scroll: !!(opts && opts.scroll) });

    const pop = document.createElement("div");
    pop.className = "popover";
    const position = note.position;
    const contextPreview = [position.context_before, position.selected_text ? `» ${position.selected_text} «` : "", position.context_after]
      .filter(Boolean)
      .join(" ");
    const missingHint = highlight && highlight.missing
      ? '<div class="popover-hint">Anchor not found in the current document — showing the note anyway.</div>'
      : "";
    pop.innerHTML = `
      ${missingHint}
      <div class="popover-context">${escapeHtml(contextPreview)}</div>
      <textarea>${escapeHtml(note.note)}</textarea>
      <div class="popover-actions">
        <button class="btn danger small" data-action="delete">Delete</button>
        <button class="btn secondary small" data-action="toggle">
          Mark as ${note.status === "done" ? "pending" : "done"}
        </button>
        <button class="btn small" data-action="save">Save</button>
      </div>
    `;
    document.body.appendChild(pop);

    let x = opts && opts.x != null ? opts.x : null;
    let y = opts && opts.y != null ? opts.y : null;
    if (x == null || y == null) {
      const rect = highlight && highlight.anchorRect ? highlight.anchorRect() : null;
      x = rect ? rect.right + 12 : window.innerWidth / 2 - 150;
      y = rect ? rect.top : window.innerHeight / 2 - 100;
    }
    positionPopover(pop, x, y);

    pop.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm("Delete this note?")) return;
      await deleteNoteApi(note.id);
      delete notesById[note.id];
      document.querySelectorAll(`.note-marker[data-note-id="${note.id}"]`).forEach((m) => m.remove());
      closePopover();
      renderNoteList(Object.values(notesById));
    });

    pop.querySelector('[data-action="toggle"]').addEventListener("click", async () => {
      const updated = await updateNote(note.id, { status: note.status === "done" ? "pending" : "done" });
      notesById[updated.id] = updated;
      closePopover();
      refreshMarkerState(updated);
      renderNoteList(Object.values(notesById));
    });

    pop.querySelector('[data-action="save"]').addEventListener("click", async () => {
      const text = pop.querySelector("textarea").value.trim();
      if (!text) return;
      const updated = await updateNote(note.id, { note: text });
      notesById[updated.id] = updated;
      closePopover();
      renderNoteList(Object.values(notesById));
    });
  }

  function positionPopover(pop, x, y) {
    const m = 8;
    const w = pop.offsetWidth || 300;
    const h = pop.offsetHeight || 220;
    pop.style.left = clamp(x, m, Math.max(m, window.innerWidth - w - m)) + "px";
    pop.style.top = clamp(y, m, Math.max(m, window.innerHeight - h - m)) + "px";
  }

  document.addEventListener("click", (e) => {
    if (
      !e.target.closest(".popover") &&
      !e.target.closest(".doc-block") &&
      !e.target.closest(".note-marker") &&
      !e.target.closest(".pdf-page-wrap") &&
      !e.target.closest(".note-list-item") &&
      !e.target.closest(".sidebar-toggle")
    ) {
      closePopover();
    }
  });

  // ---------- Sidebar: note list ----------

  function openNoteFromList(note) {
    openEditPopover(note, { scroll: true });
  }

  function renderNoteList(notes) {
    noteListEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "notes-panel-header";
    const label = document.createElement("span");
    label.textContent = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "btn secondary small";
    toggleBtn.textContent = selectionMode ? "Cancel" : "Select";
    toggleBtn.addEventListener("click", () => {
      selectionMode = !selectionMode;
      selectedNoteIds.clear();
      renderNoteList(Object.values(notesById));
    });
    header.appendChild(label);
    header.appendChild(toggleBtn);
    noteListEl.appendChild(header);

    if (selectionMode && selectedNoteIds.size > 0) {
      const bar = document.createElement("div");
      bar.className = "notes-bulk-bar";
      const countLabel = document.createElement("span");
      countLabel.textContent = `${selectedNoteIds.size} selected`;
      bar.appendChild(countLabel);
      [
        ["pending", "Mark pending", "secondary"],
        ["done", "Mark done", "secondary"],
        ["delete", "Delete", "danger"],
      ].forEach(([action, actionLabel, variant]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `btn ${variant} small`;
        btn.textContent = actionLabel;
        btn.addEventListener("click", () => runBulkAction(action));
        bar.appendChild(btn);
      });
      noteListEl.appendChild(bar);
    }

    if (!notes.length) {
      noteListEl.insertAdjacentHTML("beforeend", '<div class="hint">No notes yet.</div>');
      return;
    }

    const groups = [
      { key: "pending", label: "Pending" },
      { key: "done", label: "Done" },
    ];
    groups.forEach((group) => {
      const items = notes
        .filter((n) => n.status === group.key)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      if (!items.length) return;

      const section = document.createElement("div");
      section.className = "note-group";
      const groupHeader = document.createElement("div");
      groupHeader.className = "note-group-header";
      groupHeader.innerHTML = `${group.label} <span class="count">${items.length}</span>`;
      section.appendChild(groupHeader);

      items.forEach((note) => {
        const anchorPreview = note.position.selected_text || note.position.anchor_text;
        const item = document.createElement("div");
        item.className = "note-list-item" + (selectedNoteIds.has(note.id) ? " selected" : "");
        const checkboxHtml = selectionMode
          ? `<input type="checkbox" class="note-select-checkbox"${selectedNoteIds.has(note.id) ? " checked" : ""}>`
          : "";
        item.innerHTML = `
          <div class="note-list-item-row">
            ${checkboxHtml}
            <div class="note-list-item-body">
              <div class="note-text">${escapeHtml(note.note.slice(0, 90))}${note.note.length > 90 ? "…" : ""}</div>
              ${anchorPreview ? `<div class="note-anchor">near "${escapeHtml(anchorPreview.slice(0, 40))}"</div>` : ""}
            </div>
          </div>
        `;
        item.addEventListener("click", () => {
          if (selectionMode) {
            if (selectedNoteIds.has(note.id)) selectedNoteIds.delete(note.id);
            else selectedNoteIds.add(note.id);
            renderNoteList(Object.values(notesById));
          } else {
            openNoteFromList(note);
          }
        });
        section.appendChild(item);
      });

      noteListEl.appendChild(section);
    });
  }

  async function runBulkAction(action) {
    const ids = Array.from(selectedNoteIds);
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} note(s)?`)) return;

    let updated;
    try {
      updated = await bulkNotesApi(ids, action);
    } catch (e) {
      alert(e.message);
      return;
    }
    const updatedById = {};
    updated.forEach((n) => (updatedById[n.id] = n));

    document.querySelectorAll(".note-marker").forEach((m) => {
      const id = m.dataset.noteId;
      if (!updatedById[id]) {
        m.remove();
      } else {
        m.classList.toggle("done", updatedById[id].status === "done");
      }
    });

    notesById = updatedById;
    selectedNoteIds.clear();
    selectionMode = false;
    renderNoteList(Object.values(notesById));
  }

  function refreshMarkerState(note) {
    document.querySelectorAll(`.note-marker[data-note-id="${note.id}"]`).forEach((m) => {
      m.classList.toggle("done", note.status === "done");
    });
  }

  // ---------- Collapsible outline tree (shared by md/docx and pdf) ----------

  function buildOutlineTree(entries) {
    const root = [];
    const stack = []; // {node, level}
    entries.forEach((entry) => {
      const node = Object.assign({}, entry, { children: [] });
      while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
      if (stack.length) {
        stack[stack.length - 1].node.children.push(node);
      } else {
        root.push(node);
      }
      stack.push({ node, level: node.level });
    });
    return root;
  }

  function renderOutlineTree(nodes, ul, opts) {
    nodes.forEach((node) => {
      const li = document.createElement("li");
      li.className = "outline-node";
      const row = document.createElement("div");
      row.className = "outline-row";

      if (node.children.length) {
        const caret = document.createElement("button");
        caret.type = "button";
        caret.className = "outline-caret";
        caret.textContent = "▾";
        caret.title = "Collapse/expand";
        caret.addEventListener("click", (e) => {
          e.preventDefault();
          li.classList.toggle("collapsed");
        });
        row.appendChild(caret);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "outline-caret-spacer";
        row.appendChild(spacer);
      }

      const a = document.createElement("a");
      a.href = opts.hrefFor(node);
      a.className = `outline-lvl-${Math.min(node.level, 3)}`;
      a.textContent = opts.textFor(node);
      a.title = opts.textFor(node);
      if (opts.onClick) a.addEventListener("click", (e) => opts.onClick(e, node));
      row.appendChild(a);

      li.appendChild(row);
      if (node.children.length) {
        const childUl = document.createElement("ul");
        childUl.className = "outline-list";
        renderOutlineTree(node.children, childUl, opts);
        li.appendChild(childUl);
      }
      ul.appendChild(li);
    });
  }

  // ---------- Markdown / DOCX rendering ----------

  function computeHeadingPaths() {
    const blocks = docPane.querySelectorAll(".doc-block");
    const stack = [];
    blocks.forEach((block) => {
      const level = block.dataset.headingLevel ? parseInt(block.dataset.headingLevel, 10) : null;
      if (level) {
        stack[level - 1] = block.textContent.trim().slice(0, 120);
        stack.length = level;
      }
      const path = stack.filter(Boolean);
      block.dataset.headingPath = JSON.stringify(path);
      block.dataset.chapter = path.length ? path[path.length - 1] : "";
    });
  }

  function buildOutlineSidebar(outline) {
    outlineList.innerHTML = "";
    if (!outline.length) {
      outlineList.innerHTML = '<li class="hint">No chapters found.</li>';
      return;
    }
    renderOutlineTree(buildOutlineTree(outline), outlineList, {
      hrefFor: (n) => `#${n.id}`,
      textFor: (n) => n.text,
    });
  }

  function buildAnchor(block) {
    if (cfg.docType === "docx") {
      return { paragraph_index: parseInt(block.dataset.paragraphIndex, 10) };
    }
    return { line_number: parseInt(block.dataset.line, 10) };
  }

  function offsetWithinBlock(block, node, nodeOffset) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let total = 0;
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + nodeOffset;
      total += n.textContent.length;
    }
    return total;
  }

  function getCaretInfoFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos || !pos.offsetNode) return null;
      return { node: pos.offsetNode, offset: pos.offset };
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (!range) return null;
      return { node: range.startContainer, offset: range.startOffset };
    }
    return null;
  }

  function wordBoundsAt(text, offset) {
    const isWordChar = (ch) => !!ch && /\S/.test(ch);
    let start = Math.max(0, Math.min(offset, text.length));
    let end = start;
    while (start > 0 && isWordChar(text[start - 1])) start--;
    while (end < text.length && isWordChar(text[end])) end++;
    return { start, end, word: text.slice(start, end) };
  }

  function handleBlockClick(e) {
    const block = e.target.closest(".doc-block");
    if (!block) return;
    const prevText = block.previousElementSibling ? block.previousElementSibling.textContent.trim() : "";
    const ownText = block.textContent.trim();

    let anchorText = "";
    let charOffset = null;
    let charLength = 0;
    const caret = getCaretInfoFromPoint(e.clientX, e.clientY);
    if (caret && block.contains(caret.node)) {
      const blockOffset = offsetWithinBlock(block, caret.node, caret.offset);
      const bounds = wordBoundsAt(block.textContent, blockOffset);
      if (bounds.word) {
        anchorText = bounds.word;
        charOffset = bounds.start;
        charLength = bounds.end - bounds.start;
      }
    }

    const quote = charOffset != null
      ? [
          shortWords(block.textContent.slice(0, charOffset), 4, true),
          anchorText,
          shortWords(block.textContent.slice(charOffset + charLength), 4, false),
        ].filter(Boolean).join(" ")
      : ownText.slice(0, 80);

    const position = Object.assign(
      {
        type: "point",
        chapter: block.dataset.chapter || null,
        heading_path: JSON.parse(block.dataset.headingPath || "[]"),
        context_before: prevText.slice(-150),
        context_after: ownText.slice(0, 150),
        anchor_text: anchorText,
        char_offset: charOffset,
        char_length: charLength,
        quote: quote,
      },
      buildAnchor(block)
    );
    openCreatePopover(e.clientX + 12, e.clientY, position);
  }

  function handleBlockSelection(sel) {
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const block = startEl.closest(".doc-block");
    if (!block) return false;

    const fullText = block.textContent;
    const selectedText = sel.toString();
    const startOffset = offsetWithinBlock(block, range.startContainer, range.startOffset);
    const endOffset = startOffset + selectedText.length;

    const position = Object.assign(
      {
        type: "selection",
        chapter: block.dataset.chapter || null,
        heading_path: JSON.parse(block.dataset.headingPath || "[]"),
        selected_text: selectedText,
        context_before: fullText.slice(Math.max(0, startOffset - 150), startOffset),
        context_after: fullText.slice(endOffset, endOffset + 150),
        char_offset: startOffset,
        char_length: selectedText.length,
        quote: selectedText,
      },
      buildAnchor(block)
    );
    const rect = range.getBoundingClientRect();
    openCreatePopover(rect.left, rect.bottom + 8, position);
    return true;
  }

  function placeMarkerForNote(note) {
    if (cfg.docType === "pdf") {
      placePdfMarker(note);
      return;
    }
    const block = findBlockForPosition(note.position);
    if (!block) return;

    const rect = getAnchorRectInBlock(block, note.position);
    const blockRect = block.getBoundingClientRect();
    const top = avoidMarkerCollision(block, rect ? rect.top - blockRect.top : 4);

    const marker = document.createElement("div");
    marker.className = "note-marker" + (note.status === "done" ? " done" : "");
    marker.dataset.noteId = note.id;
    marker.title = note.note;
    marker.textContent = "●";
    marker.style.top = top + "px";
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = marker.getBoundingClientRect();
      openEditPopover(notesById[note.id], { x: r.right + 8, y: r.top });
    });
    block.appendChild(marker);
  }

  async function renderMarkdownOrDocx(data) {
    docPane.innerHTML = data.html || '<div class="empty-state">This document has no content.</div>';
    computeHeadingPaths();
    buildOutlineSidebar(data.outline || []);

    docPane.addEventListener("mouseup", (e) => {
      if (e.ctrlKey || e.metaKey) return;
      if (document.querySelector(".popover")) {
        closePopover();
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0 && docPane.contains(sel.anchorNode)) {
        handleBlockSelection(sel);
      } else if (e.target.closest(".doc-block") && !e.target.closest(".note-marker")) {
        handleBlockClick(e);
      }
    });

    const notes = await fetchNotes();
    notes.forEach(placeMarkerForNote);
    renderNoteList(notes);
  }

  // ---------- PDF rendering ----------

  function resolvePdfDest(dest) {
    if (typeof dest === "string") {
      return pdfDoc.getDestination(dest).then((d) => resolvePdfDestArray(d));
    }
    return resolvePdfDestArray(dest);
  }

  function resolvePdfDestArray(dest) {
    if (!dest || !dest[0]) return Promise.resolve(null);
    return pdfDoc.getPageIndex(dest[0]).then((idx) => idx + 1);
  }

  async function flattenOutline(items, level, out) {
    for (const item of items) {
      let page = null;
      try {
        page = await resolvePdfDest(item.dest);
      } catch (err) {
        page = null;
      }
      out.push({ level, title: item.title, page: page || 1, id: `pdf-p${page || 1}-${out.length}` });
      if (item.items && item.items.length) {
        await flattenOutline(item.items, level + 1, out);
      }
    }
    return out;
  }

  // Reconstructs the full ancestor path (chapter / section / subsection) for
  // a given page by walking the flattened, level-tagged outline in document
  // order and keeping a per-level stack, the same way computeHeadingPaths
  // does for markdown/docx.
  function pdfHeadingPathForPage(pageNum) {
    const stack = [];
    for (const entry of pdfOutlineFlat) {
      if (entry.page > pageNum) break;
      stack[entry.level - 1] = entry.title;
      stack.length = entry.level;
    }
    return stack.filter(Boolean);
  }

  function buildOutlineSidebarPdf() {
    outlineList.innerHTML = "";
    if (!pdfOutlineFlat.length) {
      outlineList.innerHTML = '<li class="hint">No chapters found in this PDF.</li>';
      return;
    }
    renderOutlineTree(buildOutlineTree(pdfOutlineFlat), outlineList, {
      hrefFor: (n) => `#pdf-page-${n.page}`,
      textFor: (n) => n.title,
      onClick: (e, n) => {
        e.preventDefault();
        const target = document.getElementById(`pdf-page-${n.page}`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    });
  }

  // Per-page state: the pdf.js-owned text divs (in item order — this is what
  // makes old anchor_span_index values keep working), plus geometry derived
  // from them. Lazily created so any function can reach it via the wrap.
  function pdfPageState(wrap) {
    if (!wrap.__mk) {
      wrap.__mk = {
        textDivs: [],
        textDivProperties: new WeakMap(),
        divIndex: new Map(),
        items: [],
        itemGeom: [],
        paragraphs: [],
        flatIndex: null,
        renderTask: null,
        textLayerTask: null,
      };
    }
    return wrap.__mk;
  }

  function pdfTextDivs(wrap) {
    return pdfPageState(wrap).textDivs;
  }

  function cancelPdfPageTasks(wrap) {
    const st = wrap.__mk;
    if (!st) return;
    if (st.renderTask) {
      try { st.renderTask.cancel(); } catch (err) { /* ignore */ }
      st.renderTask = null;
    }
    if (st.textLayerTask) {
      try { st.textLayerTask.cancel(); } catch (err) { /* ignore */ }
      st.textLayerTask = null;
    }
  }

  // Verbatim port of pdf.js's TextLayerBuilder#bindMouse (web/text_layer_builder.js
  // @ v3.11.174, minus the clipboard handler, which we don't need): widens the
  // hit-area for drag-selection down to wherever the mouse actually is, so
  // dragging up past the last rendered line doesn't flicker/stall.
  function bindTextLayerMouse(container) {
    container.addEventListener("mousedown", (evt) => {
      const end = container.querySelector(".endOfContent");
      if (!end) return;
      const adjustTop = evt.target !== container;
      if (adjustTop) {
        const divBounds = container.getBoundingClientRect();
        const r = Math.max(0, (evt.pageY - divBounds.top) / divBounds.height);
        end.style.top = (r * 100).toFixed(2) + "%";
      }
      end.classList.add("active");
    });
    container.addEventListener("mouseup", () => {
      const end = container.querySelector(".endOfContent");
      if (!end) return;
      end.style.top = "";
      end.classList.remove("active");
    });
  }

  async function buildPdfTextLayer(page, viewport, container, wrap) {
    const st = pdfPageState(wrap);
    cancelPdfPageTasks(wrap);
    container.textContent = "";
    wrap.style.setProperty("--scale-factor", pdfScale);

    const textContent = await page.getTextContent();
    st.textDivs = [];
    st.textDivProperties = new WeakMap();

    const task = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container,
      viewport,
      textDivs: st.textDivs,
      textDivProperties: st.textDivProperties,
      textContentItemsStr: [],
      isOffscreenCanvasSupported: true,
    });
    st.textLayerTask = task;
    await task.promise;
    st.textLayerTask = null;

    const eoc = document.createElement("div");
    eoc.className = "endOfContent";
    container.appendChild(eoc);
    bindTextLayerMouse(container);

    st.divIndex = new Map();
    st.textDivs.forEach((d, i) => st.divIndex.set(d, i));
    st.items = textContent.items;
    st.itemGeom = buildItemGeom(textContent.items, viewport);
    st.paragraphs = computeParagraphs(st.itemGeom);
    st.flatIndex = null;
  }

  // Same math pdf.js itself uses internally (src/display/text_layer.js,
  // TextLayerRenderTask._transform) to place each text item, but computed in
  // unscaled PDF units via viewport.rawDims instead of CSS pixels. That keeps
  // paragraph/line geometry valid across zoom without ever re-reading the DOM.
  function buildItemGeom(items, viewport) {
    const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
    const T = [1, 0, 0, -1, -pageX, pageY + pageHeight];
    const out = [];
    items.forEach((item, i) => {
      if (item.str === undefined) {
        out.push(null);
        return;
      }
      const tx = pdfjsLib.Util.transform(T, item.transform);
      const height = Math.hypot(tx[2], tx[3]);
      out.push({ i, left: tx[4], baseline: tx[5], height, str: item.str });
    });
    return out;
  }

  // Groups text items into visual lines (by baseline proximity, relative to
  // font height) and lines into paragraphs (gaps noticeably larger than the
  // typical line spacing). Same heuristic as before, just index-based instead
  // of reading live span.style.top/left (which pdf.js now expresses as percent
  // / calc(var(--scale-factor)*...) strings, not raw pixels).
  function computeParagraphs(itemGeom) {
    const valid = itemGeom.filter((g) => g && g.str.trim().length > 0);
    if (!valid.length) return [];

    const sorted = valid.slice().sort((a, b) => a.baseline - b.baseline || a.left - b.left);

    const lines = [];
    let currentLine = [];
    let currentBaseline = null;
    sorted.forEach((g) => {
      const threshold = Math.max(1.5, 0.35 * g.height);
      if (currentBaseline === null || Math.abs(g.baseline - currentBaseline) < threshold) {
        currentLine.push(g);
        if (currentBaseline === null) currentBaseline = g.baseline;
      } else {
        lines.push(currentLine);
        currentLine = [g];
        currentBaseline = g.baseline;
      }
    });
    if (currentLine.length) lines.push(currentLine);

    const lineBaselines = lines.map((line) => line[0].baseline);
    const gaps = [];
    for (let i = 1; i < lineBaselines.length; i++) gaps.push(lineBaselines[i] - lineBaselines[i - 1]);
    const sortedGaps = gaps.slice().sort((a, b) => a - b);
    const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;

    const paragraphLines = [];
    let current = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const gap = lineBaselines[i] - lineBaselines[i - 1];
      if (medianGap > 0 && gap > medianGap * 1.6) {
        paragraphLines.push(current);
        current = [lines[i]];
      } else {
        current.push(lines[i]);
      }
    }
    paragraphLines.push(current);

    return paragraphLines.map((paraLines) => {
      const indices = paraLines.flatMap((line) => line.map((g) => g.i));
      return {
        startIdx: Math.min(...indices),
        endIdx: Math.max(...indices),
        indices,
        lines: paraLines.map((line) => line.map((g) => g.i)),
      };
    });
  }

  function paragraphForIndex(paragraphs, idx) {
    for (const p of paragraphs) {
      if (idx >= p.startIdx && idx <= p.endIdx && p.indices.includes(idx)) return p;
    }
    return null;
  }

  function boxFromRects(rects, pageRect, className) {
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const box = document.createElement("div");
    box.className = className;
    box.style.left = left - pageRect.left + "px";
    box.style.top = top - pageRect.top + "px";
    box.style.width = right - left + "px";
    box.style.height = bottom - top + "px";
    return box;
  }

  function boxFromRect(rect, pageRect, className) {
    const box = document.createElement("div");
    box.className = className;
    box.style.left = rect.left - pageRect.left + "px";
    box.style.top = rect.top - pageRect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    return box;
  }

  // Range.getClientRects() emits one rect per text fragment, which can mean
  // several rects per visual line — merge those into a single bar per line so
  // the highlight doesn't show visible seams.
  function mergeRectsByLine(rects) {
    const sorted = rects.slice().sort((a, b) => a.top - b.top);
    const groups = [];
    sorted.forEach((r) => {
      const last = groups[groups.length - 1];
      if (last && r.top < last.top + last.height * 0.5) {
        last.rects.push(r);
        last.top = Math.min(last.top, r.top);
        last.height = Math.max(last.height, r.height);
      } else {
        groups.push({ top: r.top, height: r.height, rects: [r] });
      }
    });
    return groups.map((g) => {
      const left = Math.min(...g.rects.map((r) => r.left));
      const right = Math.max(...g.rects.map((r) => r.right));
      const top = Math.min(...g.rects.map((r) => r.top));
      const bottom = Math.max(...g.rects.map((r) => r.bottom));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    });
  }

  function paintRangeBoxes(range, wrap, layer, className) {
    const pageRect = wrap.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    return mergeRectsByLine(rects).map((r) => {
      const box = boxFromRect(r, pageRect, className);
      layer.appendChild(box);
      return box;
    });
  }

  function attachPdfHoverHighlight(wrap) {
    const st = pdfPageState(wrap);
    const highlightLayer = wrap.querySelector(".pdf-highlight-layer");
    const textLayer = wrap.querySelector(".pdf-text-layer");
    let hoverBoxes = [];
    let hoveredIdx = null;
    let pendingFrame = null;

    function clearHoverBoxes() {
      hoverBoxes.forEach((b) => b.remove());
      hoverBoxes = [];
    }

    function clearHover() {
      clearHoverBoxes();
      hoveredIdx = null;
    }

    function paintHoverFor(idx) {
      clearHoverBoxes();
      const para = paragraphForIndex(st.paragraphs, idx);
      if (!para) return;
      const pageRect = wrap.getBoundingClientRect();
      para.lines.forEach((lineIdxs) => {
        const rects = lineIdxs
          .map((i) => st.textDivs[i])
          .filter((d) => d && d.isConnected)
          .map((d) => d.getBoundingClientRect());
        if (!rects.length) return;
        const box = boxFromRects(rects, pageRect, "pdf-highlight-box hover");
        highlightLayer.appendChild(box);
        hoverBoxes.push(box);
      });
    }

    textLayer.addEventListener("mousemove", (e) => {
      if (e.target.tagName !== "SPAN") {
        if (hoveredIdx !== null) clearHover();
        return;
      }
      const idx = st.divIndex.get(e.target);
      if (idx === undefined || idx === hoveredIdx) return;
      hoveredIdx = idx;
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        paintHoverFor(hoveredIdx);
      });
    });
    textLayer.addEventListener("mouseleave", clearHover);
  }

  function createPdfPageWrap(pageNum, viewport) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-page-wrap";
    wrap.id = `pdf-page-${pageNum}`;
    wrap.dataset.pageNumber = pageNum;
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    wrap.style.width = w + "px";
    wrap.style.height = h + "px";
    wrap.style.setProperty("--scale-factor", pdfScale);

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    wrap.appendChild(canvas);

    const highlightLayer = document.createElement("div");
    highlightLayer.className = "pdf-highlight-layer";
    wrap.appendChild(highlightLayer);

    const textLayer = document.createElement("div");
    textLayer.className = "pdf-text-layer";
    wrap.appendChild(textLayer);

    return wrap;
  }

  async function renderPdfPage(pageNum) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: pdfScale });
    const wrap = createPdfPageWrap(pageNum, viewport);
    docPane.appendChild(wrap);

    const st = pdfPageState(wrap);
    const canvas = wrap.querySelector("canvas");
    const dpr = window.devicePixelRatio || 1;
    const renderTask = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    st.renderTask = renderTask;
    await renderTask.promise;
    st.renderTask = null;

    await buildPdfTextLayer(page, viewport, wrap.querySelector(".pdf-text-layer"), wrap);
    attachPdfHoverHighlight(wrap);
    return wrap;
  }

  async function renderAllPdfPages() {
    const token = ++pdfRenderToken;
    docPane.innerHTML = "";
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (token !== pdfRenderToken) return false;
      await renderPdfPage(i);
    }
    return token === pdfRenderToken;
  }

  // Re-renders every page's canvas/text layer in place (no teardown of the
  // page-wrap elements themselves), so the scrollable area never collapses
  // back to zero height and the viewport doesn't visibly jump to the top
  // while zooming.
  // Re-renders the canvas in place and asks pdf.js to rescale the existing
  // text divs (pdfjsLib.updateTextLayer) instead of rebuilding the text
  // layer from scratch. Widths/heights are calc(var(--scale-factor)*...)
  // already, so they track the new --scale-factor automatically; itemGeom
  // and paragraphs are computed in unscaled units (see buildItemGeom) so
  // they stay valid across zoom without recomputation either.
  async function updatePdfPageInPlace(pageNum) {
    const wrap = document.getElementById(`pdf-page-${pageNum}`);
    if (!wrap) return renderPdfPage(pageNum);

    cancelPdfPageTasks(wrap);
    const st = pdfPageState(wrap);

    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: pdfScale });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);

    wrap.style.width = w + "px";
    wrap.style.height = h + "px";
    wrap.style.setProperty("--scale-factor", pdfScale);

    const dpr = window.devicePixelRatio || 1;
    const canvas = wrap.querySelector("canvas");
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";

    const renderTask = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    st.renderTask = renderTask;
    await renderTask.promise;
    st.renderTask = null;

    if (st.textDivs.length) {
      pdfjsLib.updateTextLayer({
        container: wrap.querySelector(".pdf-text-layer"),
        viewport,
        textDivs: st.textDivs,
        textDivProperties: st.textDivProperties,
        isOffscreenCanvasSupported: true,
        mustRescale: true,
        mustRotate: false,
      });
    }

    wrap.querySelector(".pdf-highlight-layer").innerHTML = "";
    wrap.querySelectorAll(".note-marker").forEach((m) => m.remove());
    usedMarkerTops.delete(wrap);

    return wrap;
  }

  async function updateAllPdfPagesInPlace() {
    const token = ++pdfRenderToken;
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (token !== pdfRenderToken) return false;
      await updatePdfPageInPlace(i);
    }
    return token === pdfRenderToken;
  }

  function getScrollState() {
    const wraps = Array.from(docPane.querySelectorAll(".pdf-page-wrap"));
    if (!wraps.length) return null;
    const containerRect = viewerMain.getBoundingClientRect();
    let best = wraps[0];
    let bestDist = Infinity;
    wraps.forEach((w) => {
      const dist = Math.abs(w.getBoundingClientRect().top - containerRect.top);
      if (dist < bestDist) {
        bestDist = dist;
        best = w;
      }
    });
    const rect = best.getBoundingClientRect();
    const ratio = rect.height > 0 ? (containerRect.top - rect.top) / rect.height : 0;
    return { page: parseInt(best.dataset.pageNumber, 10), ratio: Math.max(0, Math.min(1, ratio)) };
  }

  function restoreScrollState(state) {
    if (!state) return;
    const wrap = document.getElementById(`pdf-page-${state.page}`);
    if (!wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const containerRect = viewerMain.getBoundingClientRect();
    const desiredTop = containerRect.top + state.ratio * wrapRect.height;
    viewerMain.scrollTop += wrapRect.top - desiredTop;
  }

  async function rerenderPdfPreservingPosition() {
    const scrollState = getScrollState();
    const positionToRestore = activeHighlightPosition;
    const finished = await updateAllPdfPagesInPlace();
    if (!finished) return;
    Object.values(notesById).forEach(placeMarkerForNote);
    restoreScrollState(scrollState);
    if (positionToRestore) highlightPosition(positionToRestore, { scroll: false });
  }

  function rectDistance(r, x, y) {
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    return Math.hypot(dx, dy);
  }

  function nearestTextDivToPoint(wrap, x, y, maxDist) {
    const divs = pdfTextDivs(wrap);
    let best = null;
    let bestIdx = -1;
    let bestDist = Infinity;
    divs.forEach((div, i) => {
      if (!div || !div.isConnected || !div.textContent || !div.textContent.trim()) return;
      const d = rectDistance(div.getBoundingClientRect(), x, y);
      if (d < bestDist) {
        bestDist = d;
        best = div;
        bestIdx = i;
      }
    });
    if (!best || (maxDist != null && bestDist > maxDist)) return null;
    return { div: best, idx: bestIdx };
  }

  function caretAnchorInPdf(wrap, clientX, clientY) {
    const st = pdfPageState(wrap);
    const caret = getCaretInfoFromPoint(clientX, clientY);
    if (caret) {
      const el = caret.node.nodeType === 3 ? caret.node.parentElement : caret.node;
      const span = el ? el.closest("span") : null;
      if (span && wrap.contains(span)) {
        const idx = st.divIndex.get(span);
        if (idx !== undefined) {
          return { idx, off: clamp(caret.offset, 0, (span.textContent || "").length) };
        }
      }
    }
    const nearest = nearestTextDivToPoint(wrap, clientX, clientY, 28 * pdfScale);
    if (!nearest) return null;
    return { idx: nearest.idx, off: 0 };
  }

  function handlePdfClick(e) {
    const pageWrap = e.target.closest(".pdf-page-wrap");
    if (!pageWrap) return;
    const pageNum = parseInt(pageWrap.dataset.pageNumber, 10);
    const st = pdfPageState(pageWrap);
    const anchor = caretAnchorInPdf(pageWrap, e.clientX, e.clientY);
    if (!anchor) return; // click was too far from any text (e.g. empty margin)

    const div = st.textDivs[anchor.idx];
    const text = div ? div.textContent : "";
    const bounds = wordBoundsAt(text, anchor.off);
    const anchorText = bounds.word || text;
    const charOffset = bounds.word ? bounds.start : 0;
    const charLength = Math.max(bounds.word ? bounds.end - bounds.start : text.length, 1);

    const contextAfterWords = st.textDivs.slice(anchor.idx, anchor.idx + 8).map((d) => d.textContent).join(" ");
    const contextBeforeWords = st.textDivs.slice(Math.max(0, anchor.idx - 8), anchor.idx).map((d) => d.textContent).join(" ");
    const headingPath = pdfHeadingPathForPage(pageNum);

    const quote = [shortWords(contextBeforeWords, 4, true), shortWords(contextAfterWords, 6, false)]
      .filter(Boolean)
      .join(" ");

    const position = {
      type: "point",
      page: pageNum,
      chapter: headingPath.length ? headingPath[headingPath.length - 1] : null,
      heading_path: headingPath,
      anchor_text: anchorText,
      anchor_span_index: anchor.idx,
      anchor_span_index_end: anchor.idx,
      char_offset: charOffset,
      char_length: charLength,
      char_offset_end: charOffset + charLength,
      char_base: "span",
      context_before: contextBeforeWords.slice(-150),
      context_after: contextAfterWords.slice(0, 150),
      quote: quote,
    };
    openCreatePopover(e.clientX + 12, e.clientY, position);
  }

  // Resolves a live browser selection to page-relative text-div indices +
  // char offsets. Doesn't trust range.startContainer/endContainer directly
  // (with the pdf.js .endOfContent div present, the end container is often
  // that div rather than a text span) — instead walks textDivs and asks the
  // range which ones it actually intersects.
  function anchorFromSelection(sel) {
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const wrap = startEl ? startEl.closest(".pdf-page-wrap") : null;
    if (!wrap) return null;
    const endEl = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;
    const endWrap = endEl ? endEl.closest(".pdf-page-wrap") : null;
    if (endWrap && endWrap !== wrap) return { crossPage: true };

    const st = pdfPageState(wrap);
    let startIdx = -1;
    let endIdx = -1;
    st.textDivs.forEach((div, i) => {
      if (!div || !div.isConnected || !range.intersectsNode(div)) return;
      if (startIdx < 0) startIdx = i;
      endIdx = i;
    });
    if (startIdx < 0) return null;

    const sDiv = st.textDivs[startIdx];
    const eDiv = st.textDivs[endIdx];
    const startOff = sDiv.contains(range.startContainer) ? range.startOffset : 0;
    const endOff = eDiv.contains(range.endContainer) ? range.endOffset : (eDiv.textContent || "").length;

    return { wrap, startIdx, startOff, endIdx, endOff, text: sel.toString() };
  }

  function handlePdfSelection(sel, anchor) {
    if (anchor.crossPage) {
      showToast("Select within a single page to add a note.");
      return true;
    }

    const wrap = anchor.wrap;
    const st = pdfPageState(wrap);
    const pageNum = parseInt(wrap.dataset.pageNumber, 10);
    const selectedText = sel.toString();
    const headingPath = pdfHeadingPathForPage(pageNum);

    const contextBeforeWords = st.textDivs.slice(Math.max(0, anchor.startIdx - 8), anchor.startIdx).map((d) => d.textContent).join(" ");
    const contextAfterWords = st.textDivs.slice(anchor.endIdx + 1, anchor.endIdx + 9).map((d) => d.textContent).join(" ");

    const position = {
      type: "selection",
      page: pageNum,
      chapter: headingPath.length ? headingPath[headingPath.length - 1] : null,
      heading_path: headingPath,
      selected_text: selectedText,
      anchor_span_index: anchor.startIdx,
      anchor_span_index_end: anchor.endIdx,
      char_offset: anchor.startOff,
      char_offset_end: anchor.endOff,
      char_base: "span",
      context_before: contextBeforeWords.slice(-150),
      context_after: contextAfterWords.slice(0, 150),
      quote: selectedText,
    };
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    openCreatePopover(rect.left, rect.bottom + 8, position);
    return true;
  }

  function normalizeWs(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  // Text between two (idx, off) boundaries, used to verify a resolved anchor
  // still points at the text it was created from.
  function anchorPlainText(wrap, anchor) {
    const divs = pdfTextDivs(wrap);
    if (anchor.startIdx === anchor.endIdx) {
      const d = divs[anchor.startIdx];
      return d ? d.textContent.slice(anchor.startOff, anchor.endOff) : "";
    }
    const parts = [];
    for (let i = anchor.startIdx; i <= anchor.endIdx; i++) {
      const d = divs[i];
      if (!d) continue;
      const text = d.textContent;
      if (i === anchor.startIdx) parts.push(text.slice(anchor.startOff));
      else if (i === anchor.endIdx) parts.push(text.slice(0, anchor.endOff));
      else parts.push(text);
    }
    return parts.join("");
  }

  // Whitespace-normalized page text + a char -> {idx, off} map, built once per
  // page and cached, for the text-search fallback tier.
  function buildPageFlatIndex(wrap) {
    const st = pdfPageState(wrap);
    if (st.flatIndex) return st.flatIndex;
    let text = "";
    const pos = [];
    let lastWasSpace = true;
    st.textDivs.forEach((d, i) => {
      if (!d) return;
      const t = d.textContent || "";
      if (!lastWasSpace) {
        text += " ";
        pos.push({ idx: i, off: 0 });
        lastWasSpace = true;
      }
      for (let off = 0; off < t.length; off++) {
        const ch = t[off];
        if (/\s/.test(ch)) {
          if (lastWasSpace) continue;
          text += " ";
          pos.push({ idx: i, off });
          lastWasSpace = true;
        } else {
          text += ch;
          pos.push({ idx: i, off });
          lastWasSpace = false;
        }
      }
    });
    st.flatIndex = { text, pos };
    return st.flatIndex;
  }

  function locatePdfAnchorByText(wrap, position) {
    const { text, pos } = buildPageFlatIndex(wrap);
    const needles = [];
    if (position.selected_text) {
      const t = normalizeWs(position.selected_text);
      if (t) needles.push(t);
      if (t.length > 40) needles.push(t.slice(0, 40));
    }
    if (position.anchor_text) {
      const t = normalizeWs(position.anchor_text);
      if (t) needles.push(t);
      const first = t.split(" ")[0];
      if (first) needles.push(first);
    }
    for (const needle of needles) {
      if (!needle) continue;
      const idx = text.indexOf(needle);
      if (idx < 0) continue;
      const startPos = pos[idx];
      const endPos = pos[Math.min(idx + needle.length - 1, pos.length - 1)];
      if (!startPos || !endPos) continue;
      return { startIdx: startPos.idx, startOff: startPos.off, endIdx: endPos.idx, endOff: endPos.off + 1, tier: 3 };
    }
    return null;
  }

  function normalizeAnchorOrder(a) {
    if (a.startIdx > a.endIdx || (a.startIdx === a.endIdx && a.startOff > a.endOff)) {
      return { startIdx: a.endIdx, startOff: a.endOff, endIdx: a.startIdx, endOff: a.startOff, tier: a.tier };
    }
    return a;
  }

  // 1: v2 exact (char_base:"span") anchor, verified against selected_text/
  //    anchor_text; falls back to a text search if verification fails.
  // 2: legacy index-only note (pre char_offset) — text search first, since
  //    anchor_span_index_end on old selections often just repeats the start
  //    and would otherwise highlight a single item instead of the phrase.
  // 3: null — caller shows an explicit "anchor not found" state.
  function locatePdfAnchor(wrap, position) {
    const divs = pdfTextDivs(wrap);
    if (!divs.length) return null;

    const isV2 = position.char_base === "span";

    if (isV2 && position.anchor_span_index != null && divs[position.anchor_span_index]) {
      const startIdx = position.anchor_span_index;
      const startLen = (divs[startIdx].textContent || "").length;
      const startOff = clamp(position.char_offset || 0, 0, startLen);
      const hasEnd = position.anchor_span_index_end != null && divs[position.anchor_span_index_end];
      const endIdx = hasEnd ? position.anchor_span_index_end : startIdx;
      const endLen = (divs[endIdx].textContent || "").length;
      const endOff = position.char_offset_end != null
        ? clamp(position.char_offset_end, 0, endLen)
        : position.type === "point"
          ? clamp(startOff + (position.char_length || 1), 0, endLen)
          : endLen;
      const tier1 = normalizeAnchorOrder({ startIdx, startOff, endIdx, endOff, tier: 1 });

      const expected = normalizeWs(position.selected_text || position.anchor_text || "");
      if (!expected || normalizeWs(anchorPlainText(wrap, tier1)) === expected) return tier1;
      return locatePdfAnchorByText(wrap, position) || tier1;
    }

    const viaText = locatePdfAnchorByText(wrap, position);
    if (viaText) return viaText;

    if (position.anchor_span_index != null && divs[position.anchor_span_index]) {
      const startIdx = position.anchor_span_index;
      const hasEnd = position.anchor_span_index_end != null
        && divs[position.anchor_span_index_end]
        && position.anchor_span_index_end >= startIdx;
      const endIdx = hasEnd ? position.anchor_span_index_end : startIdx;
      return { startIdx, startOff: 0, endIdx, endOff: (divs[endIdx].textContent || "").length, tier: 2 };
    }

    return null;
  }

  function connectedDivIndex(divs, idx, dir) {
    for (let i = idx; i >= 0 && i < divs.length; i += dir) {
      const d = divs[i];
      if (d && d.isConnected && d.firstChild) return i;
    }
    for (let i = idx; i >= 0 && i < divs.length; i -= dir) {
      const d = divs[i];
      if (d && d.isConnected && d.firstChild) return i;
    }
    return -1;
  }

  // Builds a real DOM Range from a resolved anchor. Handles: the target span
  // being detached (empty-string pdf.js items aren't appended to the DOM —
  // walk to the nearest connected one), offsets past the text length (clamp),
  // start > end (comparePoint + swap), and a collapsed result (widen by one
  // character, or select the whole div as a last resort).
  function pdfRangeFromAnchor(wrap, anchor) {
    const divs = pdfTextDivs(wrap);
    const sIdx = connectedDivIndex(divs, anchor.startIdx, 1);
    const eIdx = connectedDivIndex(divs, anchor.endIdx, -1);
    if (sIdx < 0 || eIdx < 0) return null;

    const sDiv = divs[sIdx];
    const eDiv = divs[eIdx];
    const sNode = sDiv.firstChild;
    const eNode = eDiv.firstChild;
    const sOff = clamp(sIdx === anchor.startIdx ? anchor.startOff : 0, 0, sNode.length);
    const eOff = clamp(eIdx === anchor.endIdx ? anchor.endOff : eNode.length, 0, eNode.length);

    const range = document.createRange();
    try {
      range.setStart(sNode, sOff);
      range.setEnd(sNode, sOff);
      if (range.comparePoint(eNode, eOff) >= 0) {
        range.setEnd(eNode, eOff);
      } else {
        range.setStart(eNode, eOff);
        range.setEnd(sNode, sOff);
      }
    } catch (err) {
      return null;
    }

    if (range.collapsed) {
      try {
        if (eOff < eNode.length) range.setEnd(eNode, eOff + 1);
        else if (sOff > 0) range.setStart(sNode, sOff - 1);
        else range.selectNodeContents(sDiv);
      } catch (err) {
        range.selectNodeContents(sDiv);
      }
    }
    return range;
  }

  function placePdfMarker(note) {
    const wrap = document.getElementById(`pdf-page-${note.position.page}`);
    if (!wrap) return;
    const anchor = locatePdfAnchor(wrap, note.position);
    const range = anchor ? pdfRangeFromAnchor(wrap, anchor) : null;

    const pageRect = wrap.getBoundingClientRect();
    const rawTop = range ? range.getBoundingClientRect().top - pageRect.top : 6;
    const top = avoidMarkerCollision(wrap, rawTop);

    const marker = document.createElement("div");
    marker.className = "note-marker" + (note.status === "done" ? " done" : "");
    marker.dataset.noteId = note.id;
    marker.title = note.note;
    marker.textContent = "●";
    marker.style.top = (pageRect.height ? (top / pageRect.height) * 100 : 0) + "%";
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = marker.getBoundingClientRect();
      openEditPopover(notesById[note.id], { x: r.left - 312, y: r.top });
    });
    wrap.appendChild(marker);
  }

  function highlightPdfPosition(position, scroll) {
    const wrap = document.getElementById(`pdf-page-${position.page}`);
    if (!wrap) return null;
    const layer = wrap.querySelector(".pdf-highlight-layer");
    const st = pdfPageState(wrap);
    const anchor = locatePdfAnchor(wrap, position);
    const boxes = [];
    let range = null;

    if (anchor) {
      const para = paragraphForIndex(st.paragraphs, anchor.startIdx);
      if (para) {
        const pageRect = wrap.getBoundingClientRect();
        para.lines.forEach((lineIdxs) => {
          const rects = lineIdxs
            .map((i) => st.textDivs[i])
            .filter((d) => d && d.isConnected)
            .map((d) => d.getBoundingClientRect());
          if (!rects.length) return;
          const box = boxFromRects(rects, pageRect, "pdf-highlight-box block");
          layer.appendChild(box);
          boxes.push(box);
        });
      }
      range = pdfRangeFromAnchor(wrap, anchor);
      if (range) boxes.push(...paintRangeBoxes(range, wrap, layer, "pdf-highlight-box target"));
    } else {
      wrap.classList.add("pdf-anchor-missing");
      setTimeout(() => wrap.classList.remove("pdf-anchor-missing"), 1200);
    }

    if (scroll) scrollIntoViewerCenter(range ? range.getBoundingClientRect() : wrap);

    return {
      missing: !anchor,
      clear() {
        boxes.forEach((b) => b.remove());
      },
      anchorRect() {
        const target = boxes.find((b) => b.classList.contains("target"));
        return (target || wrap).getBoundingClientRect();
      },
    };
  }

  async function initPdf() {
    const controls = document.getElementById("pdf-controls");
    controls.style.display = "flex";
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    pdfDoc = await pdfjsLib.getDocument(cfg.contentUrl).promise;
    const outline = (await pdfDoc.getOutline()) || [];
    pdfOutlineFlat = await flattenOutline(outline, 1, []);
    buildOutlineSidebarPdf();

    await renderAllPdfPages();

    docPane.addEventListener("mouseup", (e) => {
      if (e.ctrlKey || e.metaKey) return;
      if (document.querySelector(".popover")) {
        closePopover();
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0 && docPane.contains(sel.anchorNode)) {
        const anchor = anchorFromSelection(sel);
        if (!anchor) return;
        if (!anchor.crossPage) {
          const key = `${anchor.startIdx}:${anchor.startOff}:${anchor.endIdx}:${anchor.endOff}:${anchor.text.length}`;
          if (key === lastHandledSelectionKey) return;
          lastHandledSelectionKey = key;
        }
        handlePdfSelection(sel, anchor);
      } else if (e.target.closest(".pdf-page-wrap") && !e.target.closest(".note-marker")) {
        handlePdfClick(e);
      }
    });

    const notes = await fetchNotes();
    notes.forEach(placeMarkerForNote);
    renderNoteList(notes);

    const zoomIn = document.getElementById("zoom-in");
    const zoomOut = document.getElementById("zoom-out");
    const zoomLevel = document.getElementById("zoom-level");

    async function applyZoom(delta) {
      zoomIn.disabled = true;
      zoomOut.disabled = true;
      pdfScale = Math.min(3, Math.max(0.6, pdfScale + delta));
      zoomLevel.textContent = Math.round((pdfScale / 1.2) * 100) + "%";
      await rerenderPdfPreservingPosition();
      zoomIn.disabled = false;
      zoomOut.disabled = false;
    }

    zoomIn.addEventListener("click", () => applyZoom(0.2));
    zoomOut.addEventListener("click", () => applyZoom(-0.2));
  }

  // ---------- Boot ----------

  async function init() {
    if (cfg.docType === "pdf") {
      await initPdf();
    } else {
      const res = await fetch(cfg.contentUrl);
      const data = await res.json();
      await renderMarkdownOrDocx(data);
    }
  }

  window.MarkAIApplyExternalNotes = function (notes) {
    const incoming = new Set(notes.map((n) => n.id));
    notes.forEach((n) => {
      const prior = notesById[n.id];
      notesById[n.id] = n;
      if (!prior) {
        placeMarkerForNote(n);
      } else if (prior.status !== n.status) {
        refreshMarkerState(n);
      }
    });
    Object.keys(notesById).forEach((id) => {
      if (!incoming.has(id)) {
        delete notesById[id];
        document.querySelectorAll(`.note-marker[data-note-id="${id}"]`).forEach((m) => m.remove());
      }
    });
    renderNoteList(Object.values(notesById));
  };

  init();
})();
