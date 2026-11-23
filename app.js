(() => {
  "use strict";

  /* ================= constants & state ================= */
  const WORLD = { w: 3200, h: 2100 };
  const WIDTH = { core: 400, hub: 270, note: 200, photo: 220, clip: 250 };
  const TYPE_NAMES = { core: "Case file", hub: "Index card", note: "Sticky note", photo: "Polaroid", clip: "Clipping" };
  const NOTE_COLORS = ["#e9d27a", "#e8a7a0", "#a9c6cf", "#bccf9a", "#efe6d2", "#d9b8d8"];
  const RED = "#a3241e";
  const DRAFT_KEY = "pinboard-draft-v1";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const viewport = $("#viewport"), world = $("#world"), nodesEl = $("#nodes"), svg = $("#strings"), labelsEl = $("#labels");

  let board = null;
  let owner = false;
  const view = { x: 0, y: 0, s: 0.4 };
  let focus = null;               // topic key
  let selected = null;            // { kind: 'node' | 'link', id }
  let tool = "select";            // 'select' | 'string'
  let connectFrom = null;
  const els = new Map();          // node id -> element
  const undoStack = [];
  let lastCheckpoint = 0;
  let saveTimer = null, saving = false, saveQueued = false, dirty = false;

  /* ================= helpers ================= */
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const nodeById = (id) => board.nodes.find((n) => n.id === id);
  const topicByKey = (k) => board.topics.find((t) => t.key === k);
  const topicColor = (n) => (n.type === "core" ? RED : topicByKey(n.topic)?.color || RED);
  const isCore = (n) => n && n.type === "core";
  const safeImg = (u) => (typeof u === "string" && (/^images\/[\w.\-\/]+$/.test(u) || /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(u) || /^https:\/\/[^\s"'()\\]+$/.test(u)) ? u : "");
  const richText = (s) => esc(s).replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const sizeOf = (n) => clamp(Number(n.s) || 1, 0.4, 3.5);
  const widthOf = (n) => n.w || WIDTH[n.type] || 220;
  const pinOf = (n) => ({ x: n.x + widthOf(n) / 2, y: n.y + 12 + 2 * sizeOf(n) });

  function toast(msg, ms = 2200) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function normalize(b) {
    const d = structuredClone(window.DEFAULT_BOARD);
    if (!b || typeof b !== "object") return d;
    const out = { ...d, ...b };
    out.topics = Array.isArray(b.topics) && b.topics.length ? b.topics : d.topics;
    out.nodes = Array.isArray(b.nodes) ? b.nodes : d.nodes;
    out.links = Array.isArray(b.links) ? b.links.filter((l) => out.nodes.some((n) => n.id === l.from) && out.nodes.some((n) => n.id === l.to)) : [];
    out.works = Array.isArray(b.works) ? b.works : [];
    if (!out.nodes.some(isCore)) out.nodes.unshift({ ...d.nodes[0] });
    return out;
  }

  /* ================= rendering ================= */
  function renderTabs() {
    $("#boardTitle").textContent = board.title || "Dehumanization";
    $("#boardSubtitle").textContent = board.subtitle || "Case File";
    document.title = `Case File: ${board.title || "Dehumanization"}`;
    const tabs = $("#tabs");
    tabs.innerHTML = board.topics.map((t) =>
      `<button class="tab${focus === t.key ? " active" : ""}" data-topic="${esc(t.key)}" style="--c:${esc(t.color)}" aria-pressed="${focus === t.key}">${esc(t.name)}</button>`
    ).join("") + `<button class="tab works" data-works>Works Cited</button>`;
  }

  function faceHTML(n) {
    const title = `<h3>${esc(n.title || "")}</h3>`;
    const text = `<p>${esc(n.text || "")}</p>`;
    if (n.type === "photo") {
      const img = safeImg(n.img);
      return `<div class="face"><div class="img${img ? " has" : ""}"${img ? ` style="background-image:url('${img}')"` : ""}>${img ? "" : "<span>?</span>"}</div>${title}${text}</div>`;
    }
    return `<div class="face">${n.topic ? '<i class="topic-dot"></i>' : ""}${title}${text}</div>`;
  }

  function placeNode(n, el = els.get(n.id)) {
    if (!el) return;
    const s = sizeOf(n);
    el.style.transform = `translate(${n.x}px, ${n.y}px) rotate(${n.rot || 0}deg) scale(${s})`;
    el.style.setProperty("--ns", s);
  }

  function buildNode(n) {
    const el = document.createElement("div");
    el.className = `node ${n.type}`;
    el.dataset.id = n.id;
    el.style.setProperty("--tc", topicColor(n));
    if (n.type === "note") el.style.setProperty("--nc", n.color || NOTE_COLORS[0]);
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `${TYPE_NAMES[n.type] || "Card"}: ${n.title || "untitled"}`);
    if (n.w) el.style.width = n.w + "px";
    if (n.h) { el.classList.add("fixed"); el.style.setProperty("--h", n.h + "px"); }
    el.innerHTML = faceHTML(n)
      + '<i class="edge-handle" data-axis="w" title="Drag to change width" aria-hidden="true"></i>'
      + '<i class="edge-handle" data-axis="h" title="Drag to change height. Text shrinks to fit." aria-hidden="true"></i>'
      + '<i class="resize-handle" title="Drag to scale everything" aria-hidden="true"></i>';
    placeNode(n, el);
    return el;
  }

  /* Shrink the text until it fits inside a fixed-height card. */
  function fitNode(n) {
    const el = els.get(n.id), face = el?.querySelector(".face");
    if (!face) return;
    if (!n.h) { el.style.removeProperty("--fit"); return; }
    const fits = (k) => { el.style.setProperty("--fit", k); return face.scrollHeight <= face.clientHeight + 1; };
    if (fits(1)) return;
    let lo = 0.25, hi = 1, best = lo;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) { best = mid; lo = mid; } else hi = mid;
    }
    el.style.setProperty("--fit", best.toFixed(3));
  }

  function renderNodes() {
    nodesEl.textContent = "";
    els.clear();
    for (const n of board.nodes) {
      const el = buildNode(n);
      els.set(n.id, el);
      nodesEl.appendChild(el);
      fitNode(n);
    }
    applyStates();
  }

  function refreshNode(id) {
    const n = nodeById(id), old = els.get(id);
    if (!n || !old) return;
    const el = buildNode(n);
    old.replaceWith(el);
    els.set(id, el);
    fitNode(n);
    applyStates();
  }

  function curve(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
    const sag = Math.min(140, dist * 0.1) + 8;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag };
    return { d: `M${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`, mid: { x: (a.x + 2 * c.x + b.x) / 4, y: (a.y + 2 * c.y + b.y) / 4 }, angle: Math.atan2(dy, dx) };
  }

  function linkColor(l) {
    const a = nodeById(l.from), b = nodeById(l.to);
    if (focus) return topicByKey(focus)?.color || RED;
    return topicColor(isCore(a) ? b : a);
  }

  function renderLinks() {
    const parts = [`<defs><radialGradient id="shine" cx="35%" cy="30%" r="65%"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".35" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient></defs>`];
    const labels = [];
    const { litNodes } = focusSets();
    for (const l of board.links) {
      const a = nodeById(l.from), b = nodeById(l.to);
      if (!a || !b) continue;
      const g = curve(pinOf(a), pinOf(b));
      const lit = focus && litNodes.has(a.id) && litNodes.has(b.id);
      const cls = `link${lit ? " lit" : ""}${focus && !lit ? " dim" : ""}${selected?.kind === "link" && selected.id === l.id ? " selected" : ""}`;
      const lc = linkColor(l);
      parts.push(`<g class="${cls}" data-link="${esc(l.id)}" style="--lc:${esc(lc)}"><path class="string-shadow" d="${g.d}" transform="translate(3,6)"/><path class="string" d="${g.d}"/>${lit ? `<path class="flow" d="${g.d}"/>` : ""}<path class="string-hit" d="${g.d}"/></g>`);
      if (l.label) {
        let deg = (g.angle * 180) / Math.PI;
        if (deg > 90) deg -= 180; if (deg < -90) deg += 180;
        deg = clamp(deg, -22, 22);
        const show = !focus ? owner || view.s > 0.72 : lit;
        labels.push(`<div class="label${show ? " show" : ""}${lit ? " lit" : ""}" data-for="${esc(a.id)} ${esc(b.id)}" style="left:${g.mid.x}px;top:${g.mid.y}px;--r:${deg.toFixed(1)}deg;--lc:${esc(lc)}">${esc(l.label)}</div>`);
      }
    }
    // pins on top of strings
    for (const n of board.nodes) {
      const p = pinOf(n), c = isCore(n) ? RED : n.type === "hub" ? topicColor(n) : n.pin || topicColor(n);
      const dim = focus && !litNodes.has(n.id);
      const r = isCore(n) ? 11 : 8;
      parts.push(`<g class="pin${dim ? " dim" : ""}"><ellipse class="pin-shadow" cx="${p.x + 4}" cy="${p.y + 7}" rx="${r}" ry="${r * 0.7}"/><circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${esc(c)}"/><circle cx="${p.x}" cy="${p.y}" r="${r}" fill="url(#shine)"/></g>`);
    }
    if (connectFrom && preview) {
      const a = nodeById(connectFrom);
      if (a) parts.push(`<path class="preview-string" d="${curve(pinOf(a), preview).d}"/>`);
    }
    svg.innerHTML = parts.join("");
    labelsEl.innerHTML = labels.join("");
  }
  let preview = null;

  function focusSets() {
    const litNodes = new Set();
    if (focus) for (const n of board.nodes) if (n.topic === focus || isCore(n)) litNodes.add(n.id);
    return { litNodes };
  }

  function applyStates() {
    const { litNodes } = focusSets();
    for (const n of board.nodes) {
      const el = els.get(n.id);
      if (!el) continue;
      el.classList.toggle("dim", !!focus && !litNodes.has(n.id));
      el.classList.toggle("lit", !!focus && litNodes.has(n.id));
      el.classList.toggle("selected", selected?.kind === "node" && selected.id === n.id);
      el.classList.toggle("connect-from", connectFrom === n.id);
    }
    renderLinks();
  }

  function renderAll() {
    renderTabs();
    renderNodes();
    if (!$("#trail").hidden && focus) renderTrail();
  }

  /* ================= camera ================= */
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    world.style.setProperty("--zinv", Math.min(1 / view.s, 2.2).toFixed(3));
  }
  let lastLabelScale = 0;
  function setView(x, y, s, fly = false) {
    view.s = clamp(s, 0.15, 2.2);
    view.x = x; view.y = y;
    world.classList.toggle("flying", fly);
    if (fly) setTimeout(() => world.classList.remove("flying"), 1150);
    applyView();
    if ((lastLabelScale > 0.72) !== (view.s > 0.72)) renderLinks();
    lastLabelScale = view.s;
  }
  function zoomAt(sx, sy, factor) {
    const s = clamp(view.s * factor, 0.15, 2.2);
    const wx = (sx - view.x) / view.s, wy = (sy - view.y) / view.s;
    setView(sx - wx * s, sy - wy * s, s);
  }
  function safeArea() {
    const w = innerWidth, h = innerHeight, narrow = w < 760;
    const top = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) + 16;
    let left = 20, right = w - 20, bottom = h - 20;
    if (!narrow && !$("#trail").hidden) left = 370;
    if (!narrow && !$("#editor").hidden) right = w - 350;
    if (narrow && !$("#trail").hidden) bottom = h * 0.54;
    if (owner) bottom = Math.min(bottom, h - 74);
    return { left, top, right, bottom };
  }
  function fitBox(box, fly = true, maxScale = 1.1) {
    const a = safeArea();
    const aw = a.right - a.left, ah = a.bottom - a.top;
    const s = clamp(Math.min(aw / (box.w + 80), ah / (box.h + 80)), 0.15, maxScale);
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    setView(a.left + aw / 2 - cx * s, a.top + ah / 2 - cy * s, s, fly);
  }
  function boxOf(ids) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const id of ids) {
      const n = nodeById(id), el = els.get(id);
      if (!n || !el) continue;
      const s = sizeOf(n), w = el.offsetWidth * s, h = el.offsetHeight * s;
      const left = n.x + el.offsetWidth / 2 - w / 2, top = n.y + 12 - 12 * s;
      x1 = Math.min(x1, left); y1 = Math.min(y1, top);
      x2 = Math.max(x2, left + w); y2 = Math.max(y2, top + h);
    }
    return x1 === Infinity ? { x: 0, y: 0, w: WORLD.w, h: WORLD.h } : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  const fitAll = (fly = true) => fitBox({ x: 0, y: 0, w: WORLD.w, h: WORLD.h }, fly);

  /* ================= focus / trail ================= */
  function setFocus(key) {
    focus = key && topicByKey(key) ? key : null;
    window.history.replaceState(null, "", focus ? `#${focus}` : location.pathname + location.search);
    renderTabs();
    applyStates();
    const trail = $("#trail");
    if (focus) {
      trail.hidden = false;
      renderTrail();
      const ids = [...focusSets().litNodes];
      requestAnimationFrame(() => fitBox(boxOf(ids)));
    } else {
      trail.hidden = true;
      fitAll();
    }
  }

  function pathToCore(startId) {
    const adj = new Map();
    for (const l of board.links) {
      if (!adj.has(l.from)) adj.set(l.from, []);
      if (!adj.has(l.to)) adj.set(l.to, []);
      adj.get(l.from).push({ id: l.to, link: l });
      adj.get(l.to).push({ id: l.from, link: l });
    }
    const prev = new Map([[startId, null]]);
    const q = [startId];
    while (q.length) {
      const id = q.shift();
      if (isCore(nodeById(id)) && id !== startId) {
        const steps = [];
        let cur = id;
        while (prev.get(cur)) { const p = prev.get(cur); steps.unshift({ id: cur, link: p.link }); cur = p.from; }
        return steps;
      }
      for (const nb of adj.get(id) || []) if (!prev.has(nb.id)) { prev.set(nb.id, { from: id, link: nb.link }); q.push(nb.id); }
    }
    return null;
  }

  function renderTrail() {
    const t = topicByKey(focus);
    if (!t) return;
    const trail = $("#trail");
    trail.style.setProperty("--tc", t.color);
    $("#trailTitle").textContent = t.name;
    const items = board.nodes.filter((n) => n.topic === focus)
      .sort((a, b) => (a.type === "hub" ? -1 : 0) - (b.type === "hub" ? -1 : 0) || a.y - b.y || a.x - b.x);
    const list = $("#trailList");
    if (!items.length) {
      list.innerHTML = `<li><p class="empty" style="padding:10px">Nothing is tagged with this topic yet.</p></li>`;
      return;
    }
    list.innerHTML = items.map((n) => {
      const steps = pathToCore(n.id);
      let how = "", path = "";
      if (steps && steps.length) {
        how = steps[0].link.label || "";
        path = steps.map((s) => nodeById(s.id)?.title || "").join(" → ");
      }
      return `<li><button data-goto="${esc(n.id)}"><span class="t-title">${esc(n.title || "Untitled")}</span>${how ? `<span class="t-how">${esc(how)}</span>` : ""}<span class="t-path">${steps ? "→ " + esc(path) : "not yet connected to the centre"}</span></button></li>`;
    }).join("");
  }

  function gotoNode(id) {
    const steps = pathToCore(id) || [];
    const ids = [id, ...steps.map((s) => s.id)];
    fitBox(boxOf(ids), true, 1.2);
    const el = els.get(id);
    if (el) { el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); setTimeout(() => el.classList.remove("pulse"), 3000); }
  }

  /* ================= pointer interactions ================= */
  const pointers = new Map();
  let gesture = null;

  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.s, y: (sy - view.y) / view.s });

  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewport.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      gesture = { type: "pinch", dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2 };
      return;
    }
    const nodeEl = e.target.closest(".node");
    const linkEl = e.target.closest("[data-link]");
    const n = nodeEl && nodeById(nodeEl.dataset.id);
    const edge = owner && n && e.target.closest(".edge-handle");
    if (edge) {
      const face = els.get(n.id)?.querySelector(".face");
      checkpoint(true);
      els.get(n.id)?.classList.add("resizing");
      gesture = { type: "box", node: n, axis: edge.dataset.axis, sx: e.clientX, sy: e.clientY, w0: widthOf(n), h0: face ? face.offsetHeight : 170, moved: true };
      return;
    }
    if (owner && n && e.target.closest(".resize-handle")) {
      const W = widthOf(n), w0 = toWorld(e.clientX, e.clientY);
      const piv = { x: n.x + W / 2, y: n.y + 12 };
      checkpoint(true);
      els.get(n.id)?.classList.add("resizing");
      gesture = { type: "resize", node: n, piv, s0: sizeOf(n), d0: Math.max(20, Math.hypot(w0.x - piv.x, w0.y - piv.y)), moved: true };
      return;
    }
    gesture = { type: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, node: n, link: linkEl?.dataset.link };
    if (owner && n && tool === "select") {
      gesture.type = "drag";
      gesture.nx = n.x; gesture.ny = n.y;
    }
  });

  viewport.addEventListener("pointermove", (e) => {
    if (connectFrom) { preview = toWorld(e.clientX, e.clientY); renderLinks(); }
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.type === "pinch" && pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      zoomAt(gesture.cx, gesture.cy, dist / gesture.dist);
      gesture.dist = dist;
      return;
    }
    if (gesture.type === "box") {
      const g = gesture, n = g.node, s = sizeOf(n), a = (n.rot || 0) * Math.PI / 180;
      const dxw = (e.clientX - g.sx) / view.s, dyw = (e.clientY - g.sy) / view.s;
      const lx = (dxw * Math.cos(a) + dyw * Math.sin(a)) / s, ly = (-dxw * Math.sin(a) + dyw * Math.cos(a)) / s;
      const el = els.get(n.id);
      if (g.axis === "w") { n.w = Math.round(clamp(g.w0 + lx, 90, 1400)); el.style.width = n.w + "px"; }
      else { n.h = Math.round(clamp(g.h0 + ly, 60, 1400)); el.classList.add("fixed"); el.style.setProperty("--h", n.h + "px"); }
      fitNode(n);
      renderLinks();
      return;
    }
    if (gesture.type === "resize") {
      const g = gesture, n = g.node, c = toWorld(e.clientX, e.clientY);
      n.s = Math.round(clamp(g.s0 * Math.hypot(c.x - g.piv.x, c.y - g.piv.y) / g.d0, 0.4, 3.5) * 100) / 100;
      placeNode(n);
      renderLinks();
      const sl = $("#editor [data-f=s]"); if (sl) sl.value = n.s;
      return;
    }
    const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
    if (!gesture.moved && gesture.type === "drag") { checkpoint(true); els.get(gesture.node.id)?.classList.add("dragging"); }
    gesture.moved = true;
    if (gesture.type === "drag") {
      const n = gesture.node;
      const W = widthOf(n), pad = Math.max(0, W * (sizeOf(n) - 1) / 2);
      n.x = Math.round(clamp(gesture.nx + dx / view.s, 30 + pad, WORLD.w - W - 30 - pad));
      n.y = Math.round(clamp(gesture.ny + dy / view.s, 30, WORLD.h - 80));
      placeNode(n);
      renderLinks();
    } else if (gesture.type === "pan") {
      viewport.classList.add("panning");
      setView(gesture.vx + dx, gesture.vy + dy, view.s);
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    viewport.classList.remove("panning");
    const g = gesture;
    if (pointers.size) { gesture = null; return; }
    gesture = null;
    if (!g || g.type === "pinch") return;
    if (g.type === "resize" || g.type === "box") {
      els.get(g.node.id)?.classList.remove("resizing");
      scheduleSave();
      if (g.type === "box") renderEditor();
      return;
    }
    if (g.type === "drag" && g.moved) {
      els.get(g.node.id)?.classList.remove("dragging");
      scheduleSave();
      return;
    }
    if (g.moved || e.type === "pointercancel") return;
    // a tap / click
    if (g.node) return onNodeClick(g.node);
    if (owner && g.link) { select({ kind: "link", id: g.link }); return; }
    if (owner) { select(null); if (connectFrom) { connectFrom = null; preview = null; applyStates(); } }
  }
  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const k = e.ctrlKey ? 0.01 : 0.0015;
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k));
  }, { passive: false });

  viewport.addEventListener("dblclick", (e) => {
    if (!owner || tool !== "select" || document.elementFromPoint(e.clientX, e.clientY)?.closest(".node, [data-link]")) return;
    const p = toWorld(e.clientX, e.clientY);
    addNode("note", p.x - 100, p.y - 20);
  });

  nodesEl.addEventListener("keydown", (e) => {
    const el = e.target.closest(".node");
    if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onNodeClick(nodeById(el.dataset.id)); }
  });

  function onNodeClick(n) {
    if (owner && tool === "string") {
      if (!connectFrom) { connectFrom = n.id; applyStates(); setHint("Now click the item to tie the string to. Esc to cancel."); return; }
      if (connectFrom !== n.id) {
        const exists = board.links.some((l) => (l.from === connectFrom && l.to === n.id) || (l.to === connectFrom && l.from === n.id));
        if (!exists) {
          checkpoint(true);
          const l = { id: uid("l"), from: connectFrom, to: n.id, label: "" };
          board.links.push(l);
          scheduleSave();
          connectFrom = null; preview = null;
          select({ kind: "link", id: l.id });
          setHint("String tied. Add a label to explain the connection, or click another item to start a new string.");
          return;
        }
        toast("Those two are already connected.");
      }
      connectFrom = null; preview = null; applyStates();
      return;
    }
    if (owner) select({ kind: "node", id: n.id });
    else openInspect(n);
  }

  /* ================= owner editing ================= */
  function setHint(text) {
    const h = $("#hint");
    h.textContent = text || "";
    h.hidden = !text;
  }

  function setTool(t) {
    tool = t;
    connectFrom = null; preview = null;
    $("#stringTool").classList.toggle("on", t === "string");
    viewport.classList.toggle("connecting", t === "string");
    setHint(t === "string" ? "String: click the first item, then the second." : "");
    applyStates();
  }

  function setOwner(on) {
    owner = on;
    document.body.classList.toggle("editing", on);
    $("#toolbar").hidden = !on;
    $("#lockBtn").classList.toggle("unlocked", on);
    $("#lockBtn").title = on ? "Lock the board (stop editing)" : "Owner: unlock editing";
    if (!on) { select(null); setTool("select"); }
    applyStates();
  }

  function select(sel) {
    selected = sel;
    applyStates();
    renderEditor();
  }

  function addNode(type, x, y) {
    checkpoint(true);
    if (x === undefined) {
      const a = safeArea();
      const c = toWorld((a.left + a.right) / 2, (a.top + a.bottom) / 2);
      x = c.x - (WIDTH[type] || 220) / 2 + (Math.random() * 80 - 40);
      y = c.y - 80 + (Math.random() * 60 - 30);
    }
    const n = {
      id: uid("n"), type, x: Math.round(clamp(x, 30, WORLD.w - 300)), y: Math.round(clamp(y, 30, WORLD.h - 200)),
      rot: Math.round((Math.random() * 8 - 4) * 10) / 10,
      title: { note: "New note", photo: "New photo", clip: "New clipping", hub: "New card" }[type] || "New",
      text: "",
      topic: focus || "",
    };
    if (type === "note") n.color = NOTE_COLORS[Math.floor(Math.random() * 4)];
    board.nodes.push(n);
    const el = buildNode(n);
    els.set(n.id, el);
    nodesEl.appendChild(el);
    scheduleSave();
    select({ kind: "node", id: n.id });
    setTimeout(() => $("#editor [data-f=title]")?.select(), 50);
  }

  function deleteSelected() {
    if (!selected) return;
    checkpoint(true);
    if (selected.kind === "node") {
      const n = nodeById(selected.id);
      if (!n || isCore(n)) return toast("The centre card can be edited but not removed.");
      board.nodes = board.nodes.filter((x) => x.id !== n.id);
      board.links = board.links.filter((l) => l.from !== n.id && l.to !== n.id);
      els.get(n.id)?.remove(); els.delete(n.id);
    } else {
      board.links = board.links.filter((l) => l.id !== selected.id);
    }
    scheduleSave();
    select(null);
  }

  function renderEditor() {
    const ed = $("#editor");
    if (!owner || !selected) { ed.hidden = true; return; }
    if (selected.kind === "link") {
      const l = board.links.find((x) => x.id === selected.id);
      if (!l) { ed.hidden = true; return; }
      const a = nodeById(l.from), b = nodeById(l.to);
      ed.innerHTML = `
        <button class="close" data-ed-close aria-label="Close">&times;</button>
        <h2>String</h2>
        <p class="muted">${esc(a?.title)} &harr; ${esc(b?.title)}</p>
        <label class="field"><span>How they connect</span><input type="text" data-lf="label" value="${esc(l.label || "")}" placeholder="e.g. children stripped of their names" /></label>
        <p class="muted">Labels on strings to the centre card appear in the evidence trail when someone clicks a topic tab.</p>
        <div class="row"><button class="btn danger" data-ed-delete>Cut string</button></div>`;
      ed.hidden = false;
      return;
    }
    const n = nodeById(selected.id);
    if (!n) { ed.hidden = true; return; }
    const conns = board.links.filter((l) => l.from === n.id || l.to === n.id);
    ed.innerHTML = `
      <button class="close" data-ed-close aria-label="Close">&times;</button>
      <h2>${esc(TYPE_NAMES[n.type])}</h2>
      ${isCore(n) ? "" : `<label class="field"><span>Kind</span><select data-f="type">${["note", "photo", "clip", "hub"].map((t) => `<option value="${t}"${n.type === t ? " selected" : ""}>${TYPE_NAMES[t]}</option>`).join("")}</select></label>`}
      <label class="field"><span>Title</span><input type="text" data-f="title" value="${esc(n.title || "")}" /></label>
      <label class="field"><span>${n.type === "photo" ? "Notes (shown when opened)" : "Text"}</span><textarea data-f="text">${esc(n.text || "")}</textarea></label>
      ${isCore(n) ? "" : `<label class="field"><span>Topic</span><select data-f="topic"><option value="">None</option>${board.topics.map((t) => `<option value="${esc(t.key)}"${n.topic === t.key ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>`}
      ${n.type === "note" ? `<div class="field"><span>Paper colour</span><div class="swatches">${NOTE_COLORS.map((c) => `<button class="swatch${(n.color || NOTE_COLORS[0]) === c ? " on" : ""}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join("")}</div></div>` : ""}
      ${n.type === "photo" ? `<div class="field"><span>Photo</span>
          <div class="thumb" style="${safeImg(n.img) ? `background-image:url('${safeImg(n.img)}')` : ""}"></div>
          <div class="row"><label class="btn" style="cursor:pointer">Upload image<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-upload hidden /></label>${n.img ? `<button class="btn" data-clear-img>Remove</button>` : ""}</div>
          <input type="url" data-f="img" value="${esc(n.img && /^(https:|images\/)/.test(n.img) ? n.img : "")}" placeholder="…or paste an https:// link, or images/photo.jpg" />
        </div>` : ""}
      <label class="field"><span>Size</span><input type="range" min="0.4" max="3" step="0.05" data-f="s" value="${sizeOf(n)}" /></label>
      <div class="field"><span>Card shape</span>
        <p class="muted">${n.w || n.h ? `Fixed${n.w ? ` width ${n.w}` : ""}${n.h ? ` height ${n.h}` : ""}. Text shrinks to fit.` : "Automatic. Drag the side or bottom handle to fix the card size."}</p>
        ${n.w || n.h ? `<div class="row"><button class="btn" data-auto-size>Back to automatic</button></div>` : ""}
      </div>
      <label class="field"><span>Tilt</span><input type="range" min="-12" max="12" step="0.5" data-f="rot" value="${n.rot || 0}" /></label>
      <div class="field"><span>Strings (${conns.length})</span>
        ${conns.length ? conns.map((l) => {
          const other = nodeById(l.from === n.id ? l.to : l.from);
          return `<div style="display:grid;gap:4px;margin-bottom:8px"><span class="muted">&rarr; ${esc(other?.title || "?")}</span><div class="row" style="flex-wrap:nowrap"><input type="text" data-link-label="${esc(l.id)}" value="${esc(l.label || "")}" placeholder="How it connects" /><button class="btn" data-cut="${esc(l.id)}" title="Cut string">&times;</button></div></div>`;
        }).join("") : `<p class="muted">No strings yet. Use the String tool in the toolbar.</p>`}
      </div>
      <div class="row">
        <button class="btn" data-ed-string>Tie string from here</button>
        <button class="btn" data-ed-front>Bring to front</button>
        ${isCore(n) ? "" : `<button class="btn" data-ed-dup>Duplicate</button><button class="btn danger" data-ed-delete>Delete</button>`}
      </div>`;
    ed.hidden = false;
  }

  const editor = $("#editor");
  editor.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.lf === "label") {
      const l = board.links.find((x) => x.id === selected?.id);
      if (!l) return;
      checkpoint(); l.label = t.value.slice(0, 120); renderLinks(); scheduleSave();
      return;
    }
    if (t.dataset.linkLabel) {
      const l = board.links.find((x) => x.id === t.dataset.linkLabel);
      if (!l) return;
      checkpoint(); l.label = t.value.slice(0, 120); renderLinks(); scheduleSave();
      return;
    }
    const f = t.dataset.f;
    const n = selected?.kind === "node" && nodeById(selected.id);
    if (!f || !n) return;
    checkpoint();
    if (f === "s") { n.s = Number(t.value); placeNode(n); renderLinks(); scheduleSave(); return; }
    if (f === "rot") { n.rot = Number(t.value); placeNode(n); renderLinks(); scheduleSave(); return; }
    if (f === "img") {
      const v = t.value.trim();
      if (v && !safeImg(v)) { t.setCustomValidity("Use an https:// link to an image"); t.reportValidity(); return; }
      t.setCustomValidity(""); n.img = v;
    } else n[f] = t.value;
    refreshNode(n.id);
    scheduleSave();
    if (f === "type" || f === "topic") { renderEditor(); if (focus) renderTrail(); }
    if (f === "title" && focus) renderTrail();
  });

  editor.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const n = selected?.kind === "node" && nodeById(selected.id);
    if (b.dataset.edClose !== undefined) return select(null);
    if (b.dataset.edDelete !== undefined) return deleteSelected();
    if (b.dataset.cut) { checkpoint(true); board.links = board.links.filter((l) => l.id !== b.dataset.cut); scheduleSave(); renderLinks(); return renderEditor(); }
    if (b.dataset.color && n) { checkpoint(true); n.color = b.dataset.color; refreshNode(n.id); scheduleSave(); return renderEditor(); }
    if (b.dataset.autoSize !== undefined && n) { checkpoint(true); delete n.w; delete n.h; refreshNode(n.id); scheduleSave(); return renderEditor(); }
    if (b.dataset.clearImg !== undefined && n) { checkpoint(true); n.img = ""; refreshNode(n.id); scheduleSave(); return renderEditor(); }
    if (b.dataset.edFront !== undefined && n) {
      checkpoint(true);
      board.nodes = [...board.nodes.filter((x) => x !== n), n];
      nodesEl.appendChild(els.get(n.id)); scheduleSave(); return;
    }
    if (b.dataset.edDup !== undefined && n) {
      checkpoint(true);
      const c = { ...structuredClone(n), id: uid("n"), x: n.x + 40, y: n.y + 40 };
      board.nodes.push(c);
      const el = buildNode(c); els.set(c.id, el); nodesEl.appendChild(el);
      scheduleSave(); return select({ kind: "node", id: c.id });
    }
    if (b.dataset.edString !== undefined && n) {
      setTool("string"); connectFrom = n.id; applyStates();
      setHint("Now click the item to tie the string to. Esc to cancel.");
    }
  });

  /* Resize an uploaded image and keep it inside the board as a data URL. */
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const src = URL.createObjectURL(file);
      img.onload = () => {
        const max = 900, k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(src);
        resolve(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(src); reject(new Error("Couldn't read that image.")); };
      img.src = src;
    });
  }

  editor.addEventListener("change", async (e) => {
    const input = e.target;
    if (!input.matches("[data-upload]") || !input.files?.[0]) return;
    const n = selected?.kind === "node" && nodeById(selected.id);
    if (!n) return;
    const label = input.closest("label");
    label.firstChild.textContent = "Processing…";
    try {
      const url = await shrinkImage(input.files[0]);
      checkpoint(true);
      n.img = url;
      refreshNode(n.id);
      scheduleSave();
    } catch (err) {
      toast(err.message || "Couldn't use that image.");
    }
    renderEditor();
  });

  /* ================= saving & undo ================= */
  function checkpoint(force = false) {
    const now = Date.now();
    if (!force && now - lastCheckpoint < 900) { lastCheckpoint = now; return; }
    lastCheckpoint = now;
    undoStack.push(JSON.stringify(board));
    if (undoStack.length > 60) undoStack.shift();
  }

  function undo() {
    const snap = undoStack.pop();
    if (!snap) return toast("Nothing to undo.");
    board = JSON.parse(snap);
    lastCheckpoint = 0;
    selected = null;
    renderAll();
    renderEditor();
    scheduleSave();
  }

  function setSaveState(text, err = false) {
    const s = $("#saveState");
    s.textContent = text;
    s.classList.toggle("err", err);
  }

  function scheduleSave() {
    if (!owner) return;
    dirty = true;
    setSaveState("Unsaved…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 900);
  }

  function save() {
    dirty = false;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(board));
      setSaveState("Saved on this device");
    } catch {
      dirty = true;
      setSaveState("Not saved (storage full)", true);
      toast("Browser storage is full. Download a backup and use smaller images.", 4000);
    }
  }

  addEventListener("beforeunload", (e) => { if (dirty && owner) { e.preventDefault(); e.returnValue = ""; } });

  function lockOut() {
    setOwner(false);
  }

  /* ================= dialogs ================= */
  function openDialog(d) { if (!d.open) d.showModal(); }
  $$("dialog.sheet").forEach((d) => {
    d.addEventListener("click", (e) => {
      if (e.target === d || e.target.closest("[data-close]")) d.close();
    });
  });

  function openInspect(n) {
    const d = $("#inspectDlg");
    const img = n.type === "photo" ? safeImg(n.img) : "";
    const t = topicByKey(n.topic);
    const conns = board.links.filter((l) => l.from === n.id || l.to === n.id);
    d.innerHTML = `
      <button class="close" data-close aria-label="Close">&times;</button>
      <div class="sheet-paper${img ? " with-img" : ""}">
        ${img ? `<div><div class="big-img" style="background-image:url('${img}')"></div></div>` : ""}
        <div>
          <p class="stamp-small">${esc(TYPE_NAMES[n.type] || "Evidence")}</p>
          <h2>${esc(n.title || "Untitled")}</h2>
          ${t ? `<div class="topic-tag" style="--tc:${esc(t.color)}"><i></i>${esc(t.name)}</div>` : ""}
          <div class="body">${richText(n.text || "")}</div>
          ${conns.length ? `<h4>Connected to</h4><ul class="conn">${conns.map((l) => {
            const o = nodeById(l.from === n.id ? l.to : l.from);
            return `<li><button data-goto="${esc(o.id)}">&rarr; ${esc(o.title)}${l.label ? ` &nbsp;<em>${esc(l.label)}</em>` : ""}</button></li>`;
          }).join("")}</ul>` : ""}
        </div>
      </div>`;
    openDialog(d);
  }
  $("#inspectDlg").addEventListener("click", (e) => {
    const g = e.target.closest("[data-goto]");
    if (!g) return;
    $("#inspectDlg").close();
    gotoNode(g.dataset.goto);
  });

  const sortKey = (s) => s.replace(/^[\s*"'“‘]+/, "").toLowerCase();

  function renderWorks() {
    const body = $("#worksBody");
    if (owner) {
      body.innerHTML = `<div class="works-edit">
        ${board.works.map((w) => `<div class="w-row"><textarea data-work="${esc(w.id)}" aria-label="Source">${esc(w.text)}</textarea><button class="btn danger" data-del-work="${esc(w.id)}" title="Remove">&times;</button></div>`).join("")}
        <div class="row"><button class="btn" data-add-work>+ Add source</button></div>
        <p class="muted">Write each source in MLA format. Wrap titles in *asterisks* to put them in italics. Viewers see the list sorted alphabetically.</p>
      </div>`;
      return;
    }
    const sorted = [...board.works].filter((w) => w.text.trim()).sort((a, b) => sortKey(a.text).localeCompare(sortKey(b.text)));
    body.innerHTML = sorted.length
      ? `<ul class="works-list">${sorted.map((w) => `<li>${richText(w.text)}</li>`).join("")}</ul>`
      : `<p class="empty">No sources filed yet.</p>`;
  }
  function openWorks() { renderWorks(); openDialog($("#worksDlg")); }
  $("#worksBody").addEventListener("input", (e) => {
    const w = board.works.find((x) => x.id === e.target.dataset.work);
    if (!w) return;
    checkpoint(); w.text = e.target.value; scheduleSave();
  });
  $("#worksBody").addEventListener("click", (e) => {
    if (e.target.closest("[data-add-work]")) {
      checkpoint(true); board.works.push({ id: uid("w"), text: "" }); scheduleSave(); renderWorks();
      $$("#worksBody textarea").at(-1)?.focus();
    }
    const del = e.target.closest("[data-del-work]");
    if (del) { checkpoint(true); board.works = board.works.filter((w) => w.id !== del.dataset.delWork); scheduleSave(); renderWorks(); }
  });

  function openSettings() {
    const b = $("#settingsBody");
    b.innerHTML = `
      <p class="stamp-small">Board</p>
      <h2>Board settings</h2>
      <label class="field"><span>Title</span><input type="text" data-s="title" value="${esc(board.title || "")}" /></label>
      <label class="field"><span>Subtitle</span><input type="text" data-s="subtitle" value="${esc(board.subtitle || "")}" /></label>
      <h3>Topic tabs</h3>
      ${board.topics.map((t, i) => `<div class="topic-row"><input type="color" data-tc="${i}" value="${esc(t.color)}" aria-label="${esc(t.name)} colour" /><input type="text" data-tn="${i}" value="${esc(t.name)}" aria-label="Topic name" /></div>`).join("")}
      <p class="muted">Tag a card with a topic so it lights up when someone clicks that tab.</p>
      <h3>Publishing</h3>
      <p class="muted">Edits save in this browser only. To make them public: Download backup, rename the file to board.json, and upload it to your GitHub repo (replace the old one).</p>
      <h3>Backup</h3>
      <div class="row">
        <button class="btn" data-export>Download backup</button>
        <label class="btn" style="cursor:pointer">Restore from backup<input type="file" accept="application/json" data-import hidden /></label>
        <button class="btn" data-discard>Discard my local edits</button>
        <button class="btn danger" data-reset>Reset to starter board</button>
      </div>`;
    openDialog($("#settingsDlg"));
  }
  $("#settingsBody").addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.s) { checkpoint(); board[t.dataset.s] = t.value; renderTabs(); scheduleSave(); }
    if (t.dataset.tn) { checkpoint(); board.topics[t.dataset.tn].name = t.value; renderTabs(); scheduleSave(); if (focus) renderTrail(); }
    if (t.dataset.tc) { checkpoint(); board.topics[t.dataset.tc].color = t.value; renderAll(); scheduleSave(); }
  });
  $("#settingsBody").addEventListener("click", (e) => {
    if (e.target.closest("[data-export]")) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(board, null, 2)], { type: "application/json" }));
      a.download = `pinboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    if (e.target.closest("[data-discard]") && confirm("Throw away the edits saved on this device and show the published board?")) {
      localStorage.removeItem(DRAFT_KEY);
      location.reload();
    }
    if (e.target.closest("[data-reset]") && confirm("Replace the whole board with the starter layout? You can undo this.")) {
      checkpoint(true);
      board = normalize(structuredClone(window.DEFAULT_BOARD));
      renderAll(); scheduleSave(); $("#settingsDlg").close(); fitAll();
    }
  });
  $("#settingsBody").addEventListener("change", async (e) => {
    if (!e.target.matches("[data-import]") || !e.target.files?.[0]) return;
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(data.nodes)) throw new Error();
      checkpoint(true);
      board = normalize(data);
      renderAll(); scheduleSave(); $("#settingsDlg").close(); fitAll();
      toast("Backup restored.");
    } catch { toast("That file isn't a pinboard backup."); }
  });

  /* ================= top-level buttons & keys ================= */
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.works !== undefined) return openWorks();
    setFocus(focus === b.dataset.topic ? null : b.dataset.topic);
  });
  $("#caseTitle").addEventListener("click", () => setFocus(null));
  $("#trailClose").addEventListener("click", () => setFocus(null));
  $("#trailList").addEventListener("click", (e) => { const b = e.target.closest("[data-goto]"); if (b) gotoNode(b.dataset.goto); });
  $("#lockBtn").addEventListener("click", () => {
    if (owner) { if (dirty) save(); lockOut(); toast("Board locked."); return; }
    setOwner(true);
    toast("Edit mode on. Drag cards to move them, or click one to edit it.", 3500);
  });
  $("#zoomIn").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, 1.3));
  $("#zoomOut").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.3));
  $("#zoomFit").addEventListener("click", () => (focus ? fitBox(boxOf([...focusSets().litNodes])) : fitAll()));
  $$("[data-add]").forEach((b) => b.addEventListener("click", () => addNode(b.dataset.add)));
  $("#stringTool").addEventListener("click", () => setTool(tool === "string" ? "select" : "string"));
  $("#undoBtn").addEventListener("click", undo);
  $("#settingsBtn").addEventListener("click", openSettings);

  addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if (e.key === "Escape") {
      if (document.querySelector("dialog[open]")) return;
      if (connectFrom || tool === "string") return setTool("select");
      if (selected) return select(null);
      if (focus) return setFocus(null);
    }
    if (typing || !owner) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); deleteSelected(); }
    else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) setTool(tool === "string" ? "select" : "string");
  });

  let resizeT;
  addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => (focus ? fitBox(boxOf([...focusSets().litNodes]), false) : fitAll(false)), 150); });

  /* ================= ambience ================= */
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // cursor light, like holding a torch over the board
  const light = $("#cursorLight");
  let lx = innerWidth / 2, ly = innerHeight / 2, tx = lx, ty = ly, lightIdle;
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    tx = e.clientX; ty = e.clientY;
    light.classList.add("on");
    clearTimeout(lightIdle);
    lightIdle = setTimeout(() => light.classList.remove("on"), 4000);
  });

  // dust motes drifting through the lamp light
  const canvas = $("#dust"), ctx = canvas.getContext("2d");
  let motes = [];
  function sizeCanvas() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function spawn(m = {}) {
    return Object.assign(m, {
      x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: Math.random() * 1.6 + 0.3,
      vx: (Math.random() - 0.5) * 0.12, vy: -(Math.random() * 0.12 + 0.02), ph: Math.random() * Math.PI * 2,
    });
  }
  function tick(t) {
    lx += (tx - lx) * 0.08; ly += (ty - ly) * 0.08;
    light.style.transform = `translate(${lx}px, ${ly}px)`;
    if (!reduceMotion) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const m of motes) {
        m.x += m.vx + Math.sin(t / 3000 + m.ph) * 0.08; m.y += m.vy;
        if (m.y < -10 || m.x < -10 || m.x > innerWidth + 10) { spawn(m); m.y = innerHeight + 5; }
        const nearLamp = Math.max(0, 1 - Math.hypot(m.x - innerWidth * 0.12, m.y - innerHeight * 0.9) / (innerWidth * 0.55));
        const a = (0.08 + nearLamp * 0.5) * (0.6 + 0.4 * Math.sin(t / 900 + m.ph));
        ctx.fillStyle = `rgba(255, 222, 170, ${a})`;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    requestAnimationFrame(tick);
  }
  sizeCanvas();
  addEventListener("resize", sizeCanvas);
  motes = Array.from({ length: innerWidth < 760 ? 35 : 80 }, () => spawn());
  requestAnimationFrame(tick);

  // room tone: low brown noise, a slow breath, and the odd crackle from the lamp
  let audio = null;
  function noiseBuffer(ac, seconds, brown) {
    const buf = ac.createBuffer(1, ac.sampleRate * seconds, ac.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  }
  function startSound() {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination);
    master.gain.linearRampToValueAtTime(0.5, ac.currentTime + 2);
    const room = ac.createBufferSource(); room.buffer = noiseBuffer(ac, 6, true); room.loop = true;
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420;
    const roomGain = ac.createGain(); roomGain.gain.value = 0.35;
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ac.createGain(); lfoGain.gain.value = 0.12;
    lfo.connect(lfoGain).connect(roomGain.gain);
    room.connect(lp).connect(roomGain).connect(master);
    room.start(); lfo.start();
    const white = noiseBuffer(ac, 0.05, false);
    let timer;
    const crackle = () => {
      const s = ac.createBufferSource(); s.buffer = white;
      const hp = ac.createBiquadFilter(); hp.type = "bandpass"; hp.frequency.value = 1800 + Math.random() * 2500; hp.Q.value = 1.2;
      const g = ac.createGain(); const now = ac.currentTime, peak = 0.02 + Math.random() * 0.06;
      g.gain.setValueAtTime(peak, now); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.02 + Math.random() * 0.04);
      s.connect(hp).connect(g).connect(master); s.start(now);
      timer = setTimeout(crackle, Math.random() < 0.2 ? 40 + Math.random() * 120 : 300 + Math.random() * 2200);
    };
    crackle();
    audio = { ac, master, stop: () => { clearTimeout(timer); master.gain.linearRampToValueAtTime(0, ac.currentTime + 0.8); setTimeout(() => ac.close(), 900); } };
  }
  $("#soundBtn").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (audio) { audio.stop(); audio = null; btn.setAttribute("aria-pressed", "false"); }
    else { startSound(); btn.setAttribute("aria-pressed", "true"); }
  });

  /* ================= init ================= */
  async function init() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch {}
    if (!saved) {
      try {
        const res = await fetch("board.json", { cache: "no-store" });
        if (res.ok) saved = await res.json();
      } catch {}
    }
    board = normalize(saved);
    renderAll();
    document.fonts?.ready.then(() => board.nodes.forEach(fitNode));
    fitAll(false);
    lastLabelScale = view.s;
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash && topicByKey(hash)) setTimeout(() => setFocus(hash), 600);
    requestAnimationFrame(() => $("#loading").classList.add("done"));
    setTimeout(() => $("#loading").remove(), 1200);
  }
  init();
})();
