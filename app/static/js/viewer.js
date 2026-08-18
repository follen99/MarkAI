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
  let pdfRenderToken = 0;
  let selectionMode = false;
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
  }

  function highlightPosition(position, opts) {
    clearHighlight();
    const scroll = !opts || opts.scroll !== false;
    activeHighlight = cfg.docType === "pdf" ? highlightPdfPosition(position, scroll) : highlightBlockPosition(position, scroll);
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

    if (scroll) block.scrollIntoView({ behavior: "smooth", block: "center" });

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
    };
  }

  // ---------- Popover ----------

  function closePopover() {
    const existing = document.querySelector(".popover");
    if (existing) existing.remove();
    clearHighlight();
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

  function openEditPopover(x, y, note) {
    closePopover();
    highlightPosition(note.position, { scroll: false });

    const pop = document.createElement("div");
    pop.className = "popover";
    const position = note.position;
    const contextPreview = [position.context_before, position.selected_text ? `» ${position.selected_text} «` : "", position.context_after]
      .filter(Boolean)
      .join(" ");
    pop.innerHTML = `
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
    const maxLeft = window.innerWidth - 320;
    const maxTop = window.scrollY + window.innerHeight - 220;
    pop.style.left = Math.min(x, maxLeft) + "px";
    pop.style.top = Math.min(y, maxTop) + "px";
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
    const marker = document.querySelector(`.note-marker[data-note-id="${note.id}"]`);
    if (marker) {
      marker.scrollIntoView({ behavior: "smooth", block: "center" });
      const rect = marker.getBoundingClientRect();
      openEditPopover(rect.right + window.scrollX + 8, rect.top + window.scrollY, note);
    } else {
      openEditPopover(window.scrollX + 340, window.scrollY + 120, note);
    }
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
    openCreatePopover(e.pageX + 12, e.pageY, position);
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
    openCreatePopover(rect.left + window.scrollX, rect.bottom + window.scrollY + 8, position);
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
      openEditPopover(r.right + window.scrollX + 8, r.top + window.scrollY, notesById[note.id]);
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

  async function renderTextLayer(page, viewport, container) {
    const textContent = await page.getTextContent();
    container.style.width = viewport.width + "px";
    container.style.height = viewport.height + "px";
    textContent.items.forEach((item) => {
      const tx = pdfjsLib.Util.transform(
        pdfjsLib.Util.transform(viewport.transform, item.transform),
        [1, 0, 0, -1, 0, 0]
      );
      const fontSize = Math.hypot(tx[2], tx[3]);
      const angle = Math.atan2(tx[1], tx[0]);
      const span = document.createElement("span");
      span.textContent = item.str;
      span.style.left = tx[4] + "px";
      span.style.top = tx[5] - fontSize + "px";
      span.style.fontSize = fontSize + "px";
      if (angle !== 0) {
        span.style.transform = `rotate(${angle}rad)`;
        span.style.transformOrigin = "0% 0%";
      }
      container.appendChild(span);
    });
  }

  // Text items from pdf.js rarely line up with real paragraphs, so group
  // them into visual lines (by top position) and then group lines into
  // paragraphs by looking for gaps between lines that are noticeably larger
  // than the typical line spacing on the page.
  function computeParagraphs(pageWrap) {
    const spans = pdfPageSpans(pageWrap);
    if (!spans.length) return [];

    const withPos = spans.map((span) => ({
      span,
      top: parseFloat(span.style.top) || 0,
      left: parseFloat(span.style.left) || 0,
    }));
    withPos.sort((a, b) => a.top - b.top || a.left - b.left);

    const lines = [];
    let currentLine = [];
    let currentTop = null;
    withPos.forEach((item) => {
      if (currentTop === null || Math.abs(item.top - currentTop) < 3) {
        currentLine.push(item);
        if (currentTop === null) currentTop = item.top;
      } else {
        lines.push(currentLine);
        currentLine = [item];
        currentTop = item.top;
      }
    });
    if (currentLine.length) lines.push(currentLine);

    const lineTops = lines.map((line) => Math.min(...line.map((i) => i.top)));
    const gaps = [];
    for (let i = 1; i < lineTops.length; i++) gaps.push(lineTops[i] - lineTops[i - 1]);
    const sortedGaps = gaps.slice().sort((a, b) => a - b);
    const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;

    const paragraphLines = [];
    let current = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const gap = lineTops[i] - lineTops[i - 1];
      if (medianGap > 0 && gap > medianGap * 1.6) {
        paragraphLines.push(current);
        current = [lines[i]];
      } else {
        current.push(lines[i]);
      }
    }
    paragraphLines.push(current);

    return paragraphLines.map((paraLines) => ({
      spans: paraLines.flatMap((line) => line.map((i) => i.span)),
      lines: paraLines.map((line) => line.map((i) => i.span)),
    }));
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

  function attachPdfHoverHighlight(pageWrap) {
    const highlightLayer = pageWrap.querySelector(".pdf-highlight-layer");
    const textLayer = pageWrap.querySelector(".pdf-text-layer");
    let hoverBoxes = [];

    function clearHover() {
      hoverBoxes.forEach((b) => b.remove());
      hoverBoxes = [];
    }

    textLayer.addEventListener("mousemove", (e) => {
      if (e.target.tagName !== "SPAN") {
        clearHover();
        return;
      }
      clearHover();
      const paragraphs = pageWrap.__mkParagraphs || [];
      const para = paragraphs.find((p) => p.spans.includes(e.target));
      if (!para) return;
      const pageRect = pageWrap.getBoundingClientRect();
      para.lines.forEach((lineSpans) => {
        const rects = lineSpans.map((s) => s.getBoundingClientRect());
        const box = boxFromRects(rects, pageRect, "pdf-highlight-box hover");
        highlightLayer.appendChild(box);
        hoverBoxes.push(box);
      });
    });
    textLayer.addEventListener("mouseleave", clearHover);
  }

  function createPdfPageWrap(pageNum, viewport) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-page-wrap";
    wrap.id = `pdf-page-${pageNum}`;
    wrap.dataset.pageNumber = pageNum;
    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
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

    await page.render({ canvasContext: wrap.querySelector("canvas").getContext("2d"), viewport }).promise;
    await renderTextLayer(page, viewport, wrap.querySelector(".pdf-text-layer"));
    wrap.__mkParagraphs = computeParagraphs(wrap);
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
  async function updatePdfPageInPlace(pageNum) {
    const wrap = document.getElementById(`pdf-page-${pageNum}`);
    if (!wrap) return renderPdfPage(pageNum);

    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: pdfScale });

    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";

    const canvas = wrap.querySelector("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const textLayer = wrap.querySelector(".pdf-text-layer");
    textLayer.innerHTML = "";
    await renderTextLayer(page, viewport, textLayer);
    wrap.__mkParagraphs = computeParagraphs(wrap);

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
    const finished = await updateAllPdfPagesInPlace();
    if (!finished) return;
    Object.values(notesById).forEach(placeMarkerForNote);
    restoreScrollState(scrollState);
  }

  function pdfPageSpans(pageWrap) {
    return Array.from(pageWrap.querySelectorAll(".pdf-text-layer span"));
  }

  function nearestSpanToPoint(spans, x, y) {
    let best = null;
    let bestDist = Infinity;
    spans.forEach((span) => {
      const r = span.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(cx - x, cy - y);
      if (d < bestDist) {
        bestDist = d;
        best = span;
      }
    });
    return best;
  }

  function handlePdfClick(e) {
    const pageWrap = e.target.closest(".pdf-page-wrap");
    if (!pageWrap) return;
    const pageNum = parseInt(pageWrap.dataset.pageNumber, 10);
    const spans = pdfPageSpans(pageWrap);
    const nearest = nearestSpanToPoint(spans, e.clientX, e.clientY);
    const idx = nearest ? spans.indexOf(nearest) : -1;
    const contextAfterWords = idx >= 0 ? spans.slice(idx, idx + 8).map((s) => s.textContent).join(" ") : "";
    const contextBeforeWords = idx >= 0 ? spans.slice(Math.max(0, idx - 8), idx).map((s) => s.textContent).join(" ") : "";
    const headingPath = pdfHeadingPathForPage(pageNum);

    const quote = [shortWords(contextBeforeWords, 4, true), shortWords(contextAfterWords, 6, false)]
      .filter(Boolean)
      .join(" ");

    const position = {
      type: "point",
      page: pageNum,
      chapter: headingPath.length ? headingPath[headingPath.length - 1] : null,
      heading_path: headingPath,
      anchor_text: nearest ? nearest.textContent : "",
      anchor_span_index: idx >= 0 ? idx : null,
      context_before: contextBeforeWords.slice(-150),
      context_after: contextAfterWords.slice(0, 150),
      quote: quote,
    };
    openCreatePopover(e.pageX + 12, e.pageY, position);
  }

  function handlePdfSelection(sel) {
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const endEl = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;
    const pageWrap = startEl.closest(".pdf-page-wrap");
    if (!pageWrap) return false;

    const spans = pdfPageSpans(pageWrap);
    const startSpan = startEl.closest("span");
    const endSpan = endEl.closest("span");
    const startIdx = startSpan ? spans.indexOf(startSpan) : -1;
    const endIdx = endSpan ? spans.indexOf(endSpan) : -1;

    const pageNum = parseInt(pageWrap.dataset.pageNumber, 10);
    const selectedText = sel.toString();
    const fullText = spans.map((s) => s.textContent).join(" ");
    const probe = selectedText.split("\n")[0].slice(0, 30);
    const idxText = probe ? fullText.indexOf(probe) : -1;
    const start = idxText >= 0 ? idxText : 0;
    const end = start + selectedText.length;
    const headingPath = pdfHeadingPathForPage(pageNum);

    const position = {
      type: "selection",
      page: pageNum,
      chapter: headingPath.length ? headingPath[headingPath.length - 1] : null,
      heading_path: headingPath,
      selected_text: selectedText,
      anchor_span_index: startIdx >= 0 ? startIdx : null,
      anchor_span_index_end: endIdx >= 0 ? endIdx : startIdx >= 0 ? startIdx : null,
      context_before: fullText.slice(Math.max(0, start - 150), start),
      context_after: fullText.slice(end, end + 150),
      quote: selectedText,
    };
    const rect = range.getBoundingClientRect();
    openCreatePopover(rect.left + window.scrollX, rect.bottom + window.scrollY + 8, position);
    return true;
  }

  // Same idea as locateAnchorInBlock: prefer the span index captured at
  // creation time, but fall back to a text search so markers/highlights
  // still work for older notes.
  function locatePdfAnchor(pageWrap, position) {
    const spans = pdfPageSpans(pageWrap);
    if (position.anchor_span_index != null && spans[position.anchor_span_index]) {
      const start = position.anchor_span_index;
      const validEnd = position.anchor_span_index_end != null && spans[position.anchor_span_index_end];
      const end = validEnd ? position.anchor_span_index_end : start;
      return { spans, start, end: end >= start ? end : start };
    }
    const target = (position.selected_text || position.anchor_text || "").split(/\s+/)[0];
    if (target) {
      const idx = spans.findIndex((s) => s.textContent.includes(target));
      if (idx >= 0) return { spans, start: idx, end: idx };
    }
    return null;
  }

  function placePdfMarker(note) {
    const pageWrap = document.getElementById(`pdf-page-${note.position.page}`);
    if (!pageWrap) return;
    const anchor = locatePdfAnchor(pageWrap, note.position);
    const span = anchor ? anchor.spans[anchor.start] : null;

    const pageRect = pageWrap.getBoundingClientRect();
    const rawTop = span ? span.getBoundingClientRect().top - pageRect.top : 4;
    const top = avoidMarkerCollision(pageWrap, rawTop);

    const marker = document.createElement("div");
    marker.className = "note-marker" + (note.status === "done" ? " done" : "");
    marker.dataset.noteId = note.id;
    marker.title = note.note;
    marker.textContent = "●";
    marker.style.left = "auto";
    marker.style.right = "-22px";
    marker.style.top = top + "px";
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = marker.getBoundingClientRect();
      openEditPopover(r.left + window.scrollX - 310, r.top + window.scrollY, notesById[note.id]);
    });
    pageWrap.style.position = "relative";
    pageWrap.appendChild(marker);
  }

  function highlightPdfPosition(position, scroll) {
    const pageWrap = document.getElementById(`pdf-page-${position.page}`);
    if (!pageWrap) return null;
    const highlightLayer = pageWrap.querySelector(".pdf-highlight-layer");
    const anchor = locatePdfAnchor(pageWrap, position);
    const boxes = [];

    if (anchor && highlightLayer) {
      const pageRect = pageWrap.getBoundingClientRect();
      const paragraphs = pageWrap.__mkParagraphs || [];
      const anchorSpan = anchor.spans[anchor.start];
      const para = paragraphs.find((p) => p.spans.includes(anchorSpan));
      if (para) {
        para.lines.forEach((lineSpans) => {
          const rects = lineSpans.map((s) => s.getBoundingClientRect());
          const box = boxFromRects(rects, pageRect, "pdf-highlight-box block");
          highlightLayer.appendChild(box);
          boxes.push(box);
        });
      }
      for (let i = anchor.start; i <= anchor.end; i++) {
        const span = anchor.spans[i];
        if (!span) continue;
        const box = boxFromRects([span.getBoundingClientRect()], pageRect, "pdf-highlight-box target");
        highlightLayer.appendChild(box);
        boxes.push(box);
      }
    }

    if (scroll) pageWrap.scrollIntoView({ behavior: "smooth", block: "center" });

    return {
      clear() {
        boxes.forEach((b) => b.remove());
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
        handlePdfSelection(sel);
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
    notes.forEach((n) => {
      const prior = notesById[n.id];
      notesById[n.id] = n;
      if (prior && prior.status !== n.status) refreshMarkerState(n);
    });
    renderNoteList(Object.values(notesById));
  };

  init();
})();
