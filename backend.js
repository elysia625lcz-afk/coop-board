/* Co-op 投递台 · 数据后端（Claude 2026-11-26）
 * 页面原来跑在 claude.ai artifact 里，用 claude.use("db" | "sample" | "downloads")。
 * 这里用 Supabase 实现同样的接口，页面其余代码不用改：
 *   db.collection(c).doc(id).set / update / delete，db.collection(c).add，db.collection(c).onSnapshot
 *   sample(prompt)  -> 弹窗：复制提示词给任何 AI，再把 AI 的回答粘回来
 *   downloads.save({filename, data}) -> 浏览器直接下载
 * 调试：地址后加 ?debug=1 显示调试面板；控制台里用 window.coop（coop.state()、coop.read("jobs")、coop.log()）。
 */
(function () {
  const SUPABASE_URL = "https://snrlbgksmydgtwwasdgk.supabase.co";
  const SUPABASE_KEY = "sb_publishable_gfZJQR2lreNoQd_gl2DHFQ_IgcNf9o4"; // publishable：可以放在网页里，数据靠行级权限保护
  const COLLECTIONS = ["jobs", "resumes", "meta", "questions", "requests", "letters", "analysis"];
  const POLL_MS = 30000;

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const cache = {};            // collection -> Map(doc_id -> {data, version})
  const listeners = {};        // collection -> [{onNext, onErr}]
  const debugLog = [];
  let uid = null, channel = null, pollTimer = null, ready = null;
  let aiKey = null;   // 用 AI 钥匙打开时（没有登录账号）
  try { aiKey = localStorage.getItem("coop.key"); } catch (e) {}

  function log(kind, msg) {
    debugLog.push({ at: new Date().toISOString(), kind, msg: String(msg) });
    if (debugLog.length > 200) debugLog.shift();
    if (kind === "error") console.warn("[coop]", msg); else console.debug("[coop]", msg);
    renderDebug();
  }
  const err = (e) => { const x = new Error(e && (e.message || e.msg) || String(e)); x.code = (e && (e.code || e.message)) || "error"; return x; };

  function snapFor(c) {
    const m = cache[c] || new Map();
    const docs = [...m.entries()].map(([id, v]) => ({ id, version: v.version, data: () => v.data }));
    return { docs, size: docs.length };
  }
  function emit(c) { (listeners[c] || []).forEach(l => { try { l.onNext(snapFor(c)); } catch (e) { log("error", e); } }); }

  async function loadAll(c) {
    const m = new Map(); let from = 0;
    if (aiKey) {
      const { data, error } = await sb.rpc("coop_ai_read", { p_key: aiKey, p_collection: c });
      if (error) throw err(error);
      data.forEach(r => m.set(r.doc_id, { data: r.data, version: r.version }));
      cache[c] = m; emit(c); return;
    }
    for (;;) {
      const { data, error } = await sb.from("coop_docs").select("doc_id,data,version").eq("collection", c).range(from, from + 999);
      if (error) throw err(error);
      data.forEach(r => m.set(r.doc_id, { data: r.data, version: r.version }));
      if (data.length < 1000) break; from += 1000;
    }
    cache[c] = m; emit(c);
  }
  async function refreshAll(why) {
    try { await Promise.all(COLLECTIONS.map(loadAll)); log("info", "刷新完成（" + why + "）"); }
    catch (e) { log("error", "刷新失败：" + e.message); COLLECTIONS.forEach(c => (listeners[c] || []).forEach(l => l.onErr && l.onErr(e))); }
  }

  async function write(writes) {
    const { data, error } = aiKey
      ? await sb.rpc("coop_ai_write", { p_key: aiKey, p_writes: writes, p_who: "browser" })
      : await sb.rpc("coop_web_write", { p_writes: writes });
    if (error) { log("error", "写入失败：" + error.message); throw err(error); }
    // 先在本地更新，页面马上看到结果；实时推送或下一次刷新会再核对一遍
    writes.forEach((w, i) => {
      const m = cache[w.collection] || (cache[w.collection] = new Map());
      const v = data[i] && data[i].version;
      if (w.op === "delete") m.delete(w.doc_id);
      else if (w.op === "set") m.set(w.doc_id, { data: w.data, version: v });
      else { const old = (m.get(w.doc_id) || {}).data || {}; const nd = { ...old, ...w.data }; Object.keys(w.data).forEach(k => { if (w.data[k] === null) delete nd[k]; }); m.set(w.doc_id, { data: nd, version: v }); }
      emit(w.collection);
    });
    log("info", "已写入 " + writes.map(w => w.op + " " + w.collection + "/" + w.doc_id).join("，"));
    return data;
  }

  function collection(c) {
    return {
      doc(id) {
        return {
          set: (data) => write([{ op: "set", collection: c, doc_id: id, data: clean(data) }]),
          update: (data) => write([{ op: "update", collection: c, doc_id: id, data: clean(data) }]),
          delete: () => write([{ op: "delete", collection: c, doc_id: id }]),
          get: async () => { const v = (cache[c] || new Map()).get(id); return { exists: !!v, id, data: () => v && v.data }; }
        };
      },
      add: async (data) => { const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); await write([{ op: "set", collection: c, doc_id: id, data: clean(data) }]); return { id }; },
      onSnapshot(onNext, onErr) {
        (listeners[c] || (listeners[c] = [])).push({ onNext, onErr });
        ready.then(() => cache[c] ? onNext(snapFor(c)) : null).catch(e => onErr && onErr(e));
        return () => { listeners[c] = (listeners[c] || []).filter(l => l.onNext !== onNext); };
      }
    };
  }
  const clean = (o) => JSON.parse(JSON.stringify(o === undefined ? {} : o)); // 去掉 undefined，保证能存成 JSON

  function startLive() {
    if (aiKey) { clearInterval(pollTimer); pollTimer = setInterval(() => { if (!document.hidden) refreshAll("定时"); }, 15000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll("回到页面"); }); return; }
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("coop_docs_" + uid)
      .on("postgres_changes", { event: "*", schema: "public", table: "coop_docs", filter: "user_id=eq." + uid }, (p) => {
        const r = p.new && p.new.collection ? p.new : p.old; if (!r || !r.collection) { refreshAll("实时推送"); return; }
        const m = cache[r.collection] || (cache[r.collection] = new Map());
        if (p.eventType === "DELETE") m.delete(r.doc_id); else m.set(r.doc_id, { data: p.new.data, version: p.new.version });
        emit(r.collection);
        if (p.new && p.new.updated_by && p.new.updated_by !== "web") log("info", p.new.updated_by + " 改了 " + r.collection + "/" + r.doc_id);
      })
      .subscribe((s) => log("info", "实时连接：" + s));
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!document.hidden) refreshAll("定时"); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll("回到页面"); });
  }

  /* ---------- 登录 ---------- */
  function loginForm(resolve) {
    const box = document.createElement("div");
    box.id = "coopLogin";
    box.innerHTML = `<div class="panel" style="max-width:380px;margin:12vh auto;padding:20px">
      <b style="font-size:17px">登录 Co-op 投递台</b>
      <p class="muted" style="font-size:13px;margin:6px 0 14px">用 Life OS 的同一个账号。登录一次后，这台设备会记住。</p>
      <input id="coopEm" type="email" autocomplete="username" placeholder="邮箱" style="width:100%;margin-bottom:8px">
      <input id="coopPw" type="password" autocomplete="current-password" placeholder="密码" style="width:100%;margin-bottom:12px">
      <button class="btn primary" id="coopGo" style="width:100%">登录</button>
      <div id="coopMsg" class="muted" style="font-size:13px;margin-top:8px"></div>
      <details style="margin-top:14px;font-size:13px"><summary class="muted">我是 AI / 用 AI 钥匙打开</summary>
        <input id="coopKey" type="password" autocomplete="off" placeholder="coop_…" style="width:100%;margin:8px 0">
        <button class="btn" id="coopKeyGo" style="width:100%">用钥匙打开</button></details></div>`;
    document.body.prepend(box);
    const go = async () => {
      box.querySelector("#coopMsg").textContent = "正在登录…";
      const { data, error } = await sb.auth.signInWithPassword({ email: box.querySelector("#coopEm").value.trim(), password: box.querySelector("#coopPw").value });
      if (error) { box.querySelector("#coopMsg").textContent = "没登录上：" + error.message; return; }
      box.remove(); resolve(data.user);
    };
    box.querySelector("#coopGo").onclick = go;
    box.querySelector("#coopKeyGo").onclick = async () => {
      const k = box.querySelector("#coopKey").value.trim(); if (!k) return;
      const { error } = await sb.rpc("coop_ai_read", { p_key: k });
      if (error) { box.querySelector("#coopMsg").textContent = "钥匙不对：" + error.message; return; }
      aiKey = k; try { localStorage.setItem("coop.key", k); } catch (e) {}
      box.remove(); resolve({ id: "key" });
    };
    box.querySelector("#coopPw").onkeydown = (e) => { if (e.key === "Enter") go(); };
  }
  async function signedIn() {
    if (aiKey) {
      const { error } = await sb.rpc("coop_ai_read", { p_key: aiKey });
      if (!error) return { id: "key" };
      aiKey = null; try { localStorage.removeItem("coop.key"); } catch (e) {}
    }
    const { data } = await sb.auth.getSession();
    if (data.session) return data.session.user;
    const boot = document.getElementById("boot"); if (boot) boot.textContent = "请先登录。";
    return new Promise(loginForm);
  }

  /* ---------- 代替 sample：任何 AI 都能做生成 ---------- */
  function manualAI(prompt, opts) {
    return new Promise((resolve, reject) => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px";
      wrap.innerHTML = `<div class="panel" style="width:min(720px,100%);max-height:92vh;overflow:auto;padding:18px">
        <b style="font-size:16px">交给任意 AI 生成</b>
        <ol class="muted" style="font-size:13px;margin:8px 0 12px;padding-left:20px">
          <li>点“复制提示词”，粘贴到任何 AI（Claude、ChatGPT、Gemini…）。</li>
          <li>把 AI 的完整回答粘到下面，点“用这个结果”。</li></ol>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <button class="btn primary" id="maiCopy">复制提示词</button>
          <button class="btn" id="maiShow">显示提示词</button></div>
        <pre id="maiPrompt" style="display:none;white-space:pre-wrap;max-height:220px;overflow:auto;font-size:12px;background:var(--sunk);padding:10px;border-radius:8px"></pre>
        <textarea id="maiAns" placeholder="把 AI 的回答粘到这里（要包含 { … } 那段 JSON）" style="width:100%;min-height:160px;margin-top:8px"></textarea>
        <div id="maiMsg" class="muted" style="font-size:13px;min-height:18px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
          <button class="btn" id="maiCancel">取消</button>
          <button class="btn primary" id="maiUse">用这个结果</button></div></div>`;
      document.body.appendChild(wrap);
      const $w = (s) => wrap.querySelector(s);
      $w("#maiPrompt").textContent = prompt;
      // 草稿保存：粘到一半关掉页面也不丢
      const key = "coop.mai." + prompt.length + "." + prompt.slice(0, 40);
      try { $w("#maiAns").value = localStorage.getItem(key) || ""; } catch (e) {}
      $w("#maiAns").oninput = () => { try { localStorage.setItem(key, $w("#maiAns").value); } catch (e) {} };
      $w("#maiCopy").onclick = async () => { try { await navigator.clipboard.writeText(prompt); $w("#maiMsg").textContent = "已复制，去 AI 那里粘贴。"; } catch (e) { $w("#maiPrompt").style.display = "block"; $w("#maiMsg").textContent = "浏览器不让直接复制，请手动全选下面的提示词复制。"; } };
      $w("#maiShow").onclick = () => { const p = $w("#maiPrompt"); p.style.display = p.style.display === "none" ? "block" : "none"; };
      const close = () => wrap.remove();
      $w("#maiCancel").onclick = () => { close(); reject({ code: "declined" }); };
      $w("#maiUse").onclick = () => {
        const t = $w("#maiAns").value; if (t.indexOf("{") < 0) { $w("#maiMsg").textContent = "没找到 { … } 格式的结果，请把 AI 的完整回答粘进来。"; return; }
        try { localStorage.removeItem(key); } catch (e) {}
        close(); resolve({ text: t, modelApplied: (opts && opts.model) || "manual", modelTierApplied: "complex" });
      };
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => { close(); reject({ code: "aborted" }); });
    });
  }

  /* ---------- 代替 downloads ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }
  };

  /* ---------- 调试面板（?debug=1） ---------- */
  const DEBUG = /[?&]debug=1/.test(location.search);
  function renderDebug() {
    if (!DEBUG) return;
    let el = document.getElementById("coopDebug");
    if (!el) { el = document.createElement("div"); el.id = "coopDebug"; el.style.cssText = "position:fixed;right:8px;bottom:8px;width:min(420px,calc(100% - 16px));max-height:40vh;overflow:auto;background:#111;color:#cfe;font:11px/1.4 ui-monospace,Menlo,monospace;padding:8px;border-radius:8px;z-index:60;opacity:.92"; document.body && document.body.appendChild(el); }
    const counts = COLLECTIONS.map(c => c + ":" + (cache[c] ? cache[c].size : "-")).join("  ");
    el.innerHTML = `<b>coop debug</b> uid=${uid ? uid.slice(0, 8) : "-"}<br>${counts}<hr style="border-color:#333">` +
      debugLog.slice(-30).reverse().map(l => `<div style="color:${l.kind === "error" ? "#f99" : "#cfe"}">${l.at.slice(11, 19)} ${l.msg.replace(/</g, "&lt;")}</div>`).join("");
  }

  /* ---------- AI 钥匙（给本机或云端的其他 AI 用） ---------- */
  async function newKey(label) { const { data, error } = await sb.rpc("coop_new_key", { p_label: label || "ai" }); if (error) throw err(error); return data; }
  async function listKeys() { const { data, error } = await sb.from("coop_keys").select("key_hash,label,created_at,last_used").order("created_at"); if (error) throw err(error); return data; }
  async function dropKey(hash) { const { error } = await sb.from("coop_keys").delete().eq("key_hash", hash); if (error) throw err(error); }
  async function recentLog(n) { const { data, error } = await sb.from("coop_log").select("at,who,op,collection,doc_id,new_version").order("id", { ascending: false }).limit(n || 50); if (error) throw err(error); return data; }

  ready = (async () => {
    const user = await signedIn(); uid = user.id; log("info", aiKey ? "用 AI 钥匙打开" : "已登录 " + uid.slice(0, 8));
    await refreshAll("首次加载"); startLive();
  })();
  ready.catch(e => log("error", "启动失败：" + e.message));

  /* ---------- 页面底部的“AI 接入与调试”入口 ---------- */
  function aiPanel() {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px";
    wrap.innerHTML = `<div class="panel" style="width:min(680px,100%);max-height:92vh;overflow:auto;padding:18px">
      <div style="display:flex;align-items:center"><b style="font-size:16px">AI 接入与调试</b><span style="flex:1"></span><button class="btn" id="apClose">关闭</button></div>
      <p class="muted" style="font-size:13px">其他 AI（Codex、Gemini、别的 Claude）用“AI 钥匙”读写这里的数据，不需要你的密码。每个 AI 一把，不用了可以作废。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="apLabel" placeholder="给谁用，例如 codex" style="flex:1;min-width:160px"><button class="btn primary" id="apNew">生成钥匙</button></div>
      <pre id="apKey" style="display:none;white-space:pre-wrap;word-break:break-all;background:var(--sunk);padding:10px;border-radius:8px;font-size:12px"></pre>
      <div id="apKeys" style="margin-top:10px;font-size:13px"></div>
      <b style="display:block;margin-top:14px">最近的改动</b><div id="apLog" class="muted" style="font-size:12px;font-family:var(--mono)"></div>
      <p class="muted" style="font-size:12px;margin-top:14px">调试：地址后加 <code>?debug=1</code> 显示实时日志；浏览器控制台里可以用 <code>coop.state()</code>、<code>coop.read("jobs")</code>、<code>coop.refresh()</code>。说明文件：Coop_Board/AGENTS.md。</p></div>`;
    document.body.appendChild(wrap);
    const $w = (s) => wrap.querySelector(s);
    $w("#apClose").onclick = () => wrap.remove();
    const showKeys = async () => {
      if (aiKey) { $w("#apKeys").textContent = "现在是用 AI 钥匙打开的，只能读写岗位数据；管理钥匙和看改动日志要用账号登录。"; $w("#apNew").disabled = true; $w("#apLog").textContent = "—"; return; }
      try {
        const ks = await listKeys();
        $w("#apKeys").innerHTML = ks.length ? ks.map(k => `<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--line)"><b>${k.label.replace(/</g, "&lt;")}</b><span class="muted">建于 ${k.created_at.slice(0, 10)} · ${k.last_used ? "上次用 " + k.last_used.slice(0, 16).replace("T", " ") : "还没用过"}</span><span style="flex:1"></span><button class="btn" data-drop="${k.key_hash}">作废</button></div>`).join("") : `<span class="muted">还没有钥匙。</span>`;
        wrap.querySelectorAll("[data-drop]").forEach(b => b.onclick = async () => { if (!confirm("作废这把钥匙？用它的 AI 会立刻读写不了。")) return; await dropKey(b.dataset.drop); showKeys(); });
      } catch (e) { $w("#apKeys").textContent = "读不到钥匙列表：" + e.message; }
      try { const L = await recentLog(15); $w("#apLog").innerHTML = L.map(l => `${l.at.slice(5, 16).replace("T", " ")} ${l.who} ${l.op} ${l.collection}/${l.doc_id}`.replace(/</g, "&lt;")).join("<br>") || "还没有"; } catch (e) { $w("#apLog").textContent = "读不到：" + e.message; }
    };
    $w("#apNew").onclick = async () => {
      try {
        const k = await newKey($w("#apLabel").value.trim() || "ai");
        const pre = $w("#apKey"); pre.style.display = "block";
        pre.textContent = "钥匙（只显示这一次，复制给要用的 AI，或存到电脑的 ~/.config/coop-board/key）：\n" + k;
        try { await navigator.clipboard.writeText(k); } catch (e) {}
        showKeys();
      } catch (e) { alert("没生成：" + e.message); }
    };
    showKeys();
  }
  ready.then(() => {
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = "AI 接入与调试"; b.id = "coopAiBtn";
    b.style.cssText = "display:block;margin:24px auto 32px;font-size:13px";
    b.onclick = aiPanel; document.body.appendChild(b);
  });

  const db = { collection };
  window.claude = {
    use: async (name) => {
      if (name === "db") { await ready; return db; }
      if (name === "sample") return manualAI;
      if (name === "downloads") return downloads;
      throw { code: "unsupported" };
    }
  };
  window.coop = {
    sb, state: () => Object.fromEntries(Object.entries(cache).map(([c, m]) => [c, m.size])),
    read: (c, id) => id ? (cache[c] || new Map()).get(id) : Object.fromEntries((cache[c] || new Map())),
    write, refresh: () => refreshAll("手动"), log: () => debugLog.slice(), newKey, listKeys, dropKey, recentLog,
    signOut: async () => { try { localStorage.removeItem("coop.key"); } catch (e) {} await sb.auth.signOut(); location.reload(); }
  };
})();
