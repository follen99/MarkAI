(function () {
  const cfg = window.MARKAI;
  const docPane = document.getElementById("doc-pane");
  const outlineList = document.getElementById("outline-list");
  const noteListEl = document.getElementById("note-list");

  let notesById = {};
  let pdfDoc = null;
  let pdfScale = 1.2;
  let pdfOutlineFlat = []; // [{level, title, page}]

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
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

  // ---------- Popover ----------

  function closePopover() {
    const existing = document.querySelector(".popover");
    if (existing) existing.remove();
  }

  function openCreatePopover(x, y, position) {
    closePopover();
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
    if (!e.target.closest(".popover") && !e.target.closest(".doc-block") && !e.target.closest(".note-marker") && !e.target.closest(".pdf-page-wrap")) {
      closePopover();
    }
  });

  // ---------- Sidebar: note list ----------

  function renderNoteList(notes) {
    if (!notes.length) {
      noteListEl.innerHTML = '<div class="hint">No notes yet.</div>';
      return;
    }
    notes.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    noteListEl.innerHTML = "";
    notes.forEach((note) => {
      const item = document.createElement("div");
      item.className = "note-list-item";
      item.innerHTML = `
        <div class="note-text">${escapeHtml(note.note.slice(0, 90))}${note.note.length > 90 ? "…" : ""}</div>
        <span class="note-status ${note.status}">${note.status}</span>
      `;
      item.addEventListener("click", () => {
        const marker = document.querySelector(`.note-marker[data-note-id="${note.id}"]`);
        if (marker) {
          marker.scrollIntoView({ behavior: "smooth", block: "center" });
          const rect = marker.getBoundingClientRect();
          openEditPopover(rect.right + window.scrollX + 8, rect.top + window.scrollY, note);
        }
      });
      noteListEl.appendChild(item);
    });
  }

  function refreshMarkerState(note) {
    document.querySelectorAll(`.note-marker[data-note-id="${note.id}"]`).forEach((m) => {
      m.classList.toggle("done", note.status === "done");
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
    if (!outline.length) {
      outlineList.innerHTML = '<li class="hint">No chapters found.</li>';
      return;
    }
    outlineList.innerHTML = "";
    outline.forEach((entry) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${entry.id}`;
      a.className = `outline-lvl-${Math.min(entry.level, 3)}`;
      a.textContent = entry.text;
      li.appendChild(a);
      outlineList.appendChild(li);
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

  function handleBlockClick(e) {
    const block = e.target.closest(".doc-block");
    if (!block) return;
    const prevText = block.previousElementSibling ? block.previousElementSibling.textContent.trim() : "";
    const ownText = block.textContent.trim();
    const position = Object.assign(
      {
        type: "point",
        chapter: block.dataset.chapter || null,
        heading_path: JSON.parse(block.dataset.headingPath || "[]"),
        context_before: prevText.slice(-150),
        context_after: ownText.slice(0, 150),
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
      },
      buildAnchor(block)
    );
    const rect = range.getBoundingClientRect();
    openCreatePopover(rect.left + window.scrollX, rect.bottom + window.scrollY + 8, position);
    return true;
  }

  function placeMarkerForNote(note) {
    let target = null;
    if (cfg.docType === "docx") {
      target = docPane.querySelector(`.doc-block[data-paragraph-index="${note.position.paragraph_index}"]`);
    } else if (cfg.docType === "md") {
      target = docPane.querySelector(`.doc-block[data-line="${note.position.line_number}"]`);
    } else if (cfg.docType === "pdf") {
      placePdfMarker(note);
      return;
    }
    if (!target) return;
    const existingCount = target.querySelectorAll(".note-marker").length;
    const marker = document.createElement("div");
    marker.className = "note-marker" + (note.status === "done" ? " done" : "");
    marker.dataset.noteId = note.id;
    marker.title = note.note;
    marker.textContent = "●";
    marker.style.top = 4 + existingCount * 20 + "px";
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = marker.getBoundingClientRect();
      openEditPopover(rect.right + window.scrollX + 8, rect.top + window.scrollY, notesById[note.id]);
    });
    target.appendChild(marker);
  }

  async function renderMarkdownOrDocx(data) {
    docPane.innerHTML = data.html || '<div class="empty-state">This document has no content.</div>';
    computeHeadingPaths();
    buildOutlineSidebar(data.outline || []);

    docPane.addEventListener("mouseup", (e) => {
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

  function nearestChapter(pageNum) {
    let found = null;
    for (const entry of pdfOutlineFlat) {
      if (entry.page <= pageNum) found = entry;
      else break;
    }
    return found ? found.title : null;
  }

  function buildOutlineSidebarPdf() {
    if (!pdfOutlineFlat.length) {
      outlineList.innerHTML = '<li class="hint">No chapters found in this PDF.</li>';
      return;
    }
    outlineList.innerHTML = "";
    pdfOutlineFlat.forEach((entry) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#pdf-page-${entry.page}`;
      a.className = `outline-lvl-${Math.min(entry.level + 1, 3)}`;
      a.textContent = entry.title;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const target = document.getElementById(`pdf-page-${entry.page}`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      li.appendChild(a);
      outlineList.appendChild(li);
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

  async function renderPdfPage(pageNum) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: pdfScale });

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

    const textLayer = document.createElement("div");
    textLayer.className = "pdf-text-layer";
    wrap.appendChild(textLayer);

    docPane.appendChild(wrap);

    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    await renderTextLayer(page, viewport, textLayer);
    return wrap;
  }

  async function renderAllPdfPages() {
    docPane.innerHTML = "";
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      await renderPdfPage(i);
    }
  }

  function pdfPageText(pageWrap) {
    return Array.from(pageWrap.querySelectorAll(".pdf-text-layer span"))
      .map((s) => s.textContent)
      .join(" ");
  }

  function handlePdfClick(e) {
    const pageWrap = e.target.closest(".pdf-page-wrap");
    if (!pageWrap) return;
    const pageNum = parseInt(pageWrap.dataset.pageNumber, 10);
    let contextAfter = "";
    if (e.target.tagName === "SPAN") {
      const spans = Array.from(pageWrap.querySelectorAll(".pdf-text-layer span"));
      const idx = spans.indexOf(e.target);
      contextAfter = spans.slice(idx, idx + 8).map((s) => s.textContent).join(" ");
    }
    const position = {
      type: "point",
      page: pageNum,
      chapter: nearestChapter(pageNum),
      context_before: "",
      context_after: contextAfter.slice(0, 150),
    };
    openCreatePopover(e.pageX + 12, e.pageY, position);
  }

  function handlePdfSelection(sel) {
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const pageWrap = startEl.closest(".pdf-page-wrap");
    if (!pageWrap) return false;

    const pageNum = parseInt(pageWrap.dataset.pageNumber, 10);
    const selectedText = sel.toString();
    const fullText = pdfPageText(pageWrap);
    const idx = fullText.indexOf(selectedText.split("\n")[0].slice(0, 30));
    const start = idx >= 0 ? idx : 0;
    const end = start + selectedText.length;

    const position = {
      type: "selection",
      page: pageNum,
      chapter: nearestChapter(pageNum),
      selected_text: selectedText,
      context_before: fullText.slice(Math.max(0, start - 150), start),
      context_after: fullText.slice(end, end + 150),
    };
    const rect = range.getBoundingClientRect();
    openCreatePopover(rect.left + window.scrollX, rect.bottom + window.scrollY + 8, position);
    return true;
  }

  function placePdfMarker(note) {
    const pageWrap = document.getElementById(`pdf-page-${note.position.page}`);
    if (!pageWrap) return;
    const existingCount = pageWrap.querySelectorAll(".note-marker").length;
    const marker = document.createElement("div");
    marker.className = "note-marker" + (note.status === "done" ? " done" : "");
    marker.dataset.noteId = note.id;
    marker.title = note.note;
    marker.textContent = "●";
    marker.style.left = "auto";
    marker.style.right = "-22px";
    marker.style.top = 4 + existingCount * 20 + "px";
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = marker.getBoundingClientRect();
      openEditPopover(rect.left + window.scrollX - 310, rect.top + window.scrollY, notesById[note.id]);
    });
    pageWrap.style.position = "relative";
    pageWrap.appendChild(marker);
  }

  async function initPdf() {
    document.getElementById("pdf-controls").style.display = "flex";
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    pdfDoc = await pdfjsLib.getDocument(cfg.contentUrl).promise;
    const outline = (await pdfDoc.getOutline()) || [];
    pdfOutlineFlat = await flattenOutline(outline, 1, []);
    buildOutlineSidebarPdf();

    await renderAllPdfPages();

    docPane.addEventListener("mouseup", (e) => {
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

    document.getElementById("zoom-in").addEventListener("click", async () => {
      pdfScale = Math.min(pdfScale + 0.2, 3);
      document.getElementById("zoom-level").textContent = Math.round((pdfScale / 1.2) * 100) + "%";
      await renderAllPdfPages();
      Object.values(notesById).forEach(placeMarkerForNote);
    });
    document.getElementById("zoom-out").addEventListener("click", async () => {
      pdfScale = Math.max(pdfScale - 0.2, 0.6);
      document.getElementById("zoom-level").textContent = Math.round((pdfScale / 1.2) * 100) + "%";
      await renderAllPdfPages();
      Object.values(notesById).forEach(placeMarkerForNote);
    });
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
