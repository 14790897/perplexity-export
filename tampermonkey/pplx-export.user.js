// ==UserScript==
// @name         Perplexity 导出集合对话 (UTF-8)
// @namespace    https://github.com/yourname/perplexity-export
// @version      0.5.0
// @charset      UTF-8
// @description  从 Perplexity 集合接口批量抓取列表并导出为 JSON；可选逐条获取 Markdown；可导出为多个/合并单个 .md；无需手动设置认证请求头。
// @author       liuweiqing
// @match        https://www.perplexity.ai/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.53/dist/zip.min.js
// @run-at       document-idle
// @icon         https://www.google.com/s2/favicons?sz=64&domain=perplexity.ai

// ==/UserScript==

(function () {
  'use strict';

  // ============ 样式 ============
  const STYLE = `
    .pplx-export-fab {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 999999;
      background: #111827;
      color: #fff;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.2;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Apple Color Emoji', 'Segoe UI Emoji';
      user-select: none;
    }
    .pplx-export-fab button {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 8px 10px;
      margin-top: 8px;
      cursor: pointer;
    }
    .pplx-export-fab button:disabled { opacity: 0.6; cursor: not-allowed; }
    .pplx-export-fab input, .pplx-export-fab select {
      width: 100%;
      box-sizing: border-box;
      margin: 6px 0;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid #374151;
      background: #0b1220;
      color: #e5e7eb;
    }
    .pplx-export-row { margin-top: 6px; }
    .pplx-export-note { color: #9ca3af; font-size: 11px; margin-top: 6px; }
  `;

  try { if (typeof GM_addStyle === 'function') GM_addStyle(STYLE); } catch (_) {}
  if (!document.getElementById('pplx-export-style')) {
    const style = document.createElement('style');
    style.id = 'pplx-export-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // ============ 工具函数 ============
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const store = {
    get(key, defVal) {
      try {
        if (typeof GM_getValue === "function") return GM_getValue(key, defVal);
        const v = localStorage.getItem(key);
        return v == null ? defVal : JSON.parse(v);
      } catch (_) {
        return defVal;
      }
    },
    set(key, val) {
      try {
        // 双写，提升在不同注入/隔离模式下的可靠性
        if (typeof GM_setValue === "function") {
          try { GM_setValue(key, val); } catch (_) {}
        }
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
      } catch (_) {}
    },
  };

  // 从当前 URL 自动提取 collection_slug：优先 query，其次 /spaces/<slug> 或 /collections/<slug>
  function extractCollectionSlugFromUrl(href) {
    try {
      const u = new URL(href);
      const byQuery = u.searchParams.get('collection_slug');
      if (byQuery) return byQuery;
      const path = u.pathname || '';
      const m = path.match(/\/(spaces|collections)\/([^\/?#]+)/i);
      if (m && m[2]) return decodeURIComponent(m[2]);
      return '';
    } catch (_) { return ''; }
  }

  function parseUrl(u) {
    try { return new URL(u); } catch { return null; }
  }

  function setUrlParam(u, key, val) {
    const url = new URL(u);
    if (val === undefined || val === null) url.searchParams.delete(key); else url.searchParams.set(key, String(val));
    return url.toString();
  }

  function guessArrayPayload(json) {
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json)) return json;
    for (const k of ['threads', 'items', 'data', 'list', 'results']) {
      if (Array.isArray(json[k])) return json[k];
    }
    let best = [];
    for (const v of Object.values(json)) {
      if (Array.isArray(v) && v.length > best.length) best = v;
    }
    return best;
  }

  function parseRetryAfter(h) {
    if (!h) return null;
    // seconds or HTTP-date; we only handle seconds
    const sec = parseInt(h, 10);
    return Number.isFinite(sec) ? Math.max(0, sec) * 1000 : null;
  }

  async function fetchWithRetry(url, options = {}, cfg = {}) {
    const {
      retries = 5,
      baseDelay = 800,
      maxDelay = 15000,
      autoBackoff = true
    } = cfg;

    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
      try {
        const resp = await fetch(url, options);
        if (resp.status === 429) {
          if (!autoBackoff) throw new Error('429 RATE_LIMITED');
          const ra = parseRetryAfter(resp.headers.get('retry-after'));
          const wait = ra != null ? ra : Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
          await sleep(wait);
          attempt++;
          continue;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp;
      } catch (e) {
        lastErr = e;
        if (attempt >= retries) break;
        if (!autoBackoff) break;
        const wait = Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        await sleep(wait);
        attempt++;
      }
    }
    throw lastErr || new Error('fetchWithRetry failed');
  }

  function downloadObjectAsJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function safeFilename(s, max = 120) {
    const base = (s || '').toString().normalize('NFC').replace(/[\r\n\t]/g, ' ').trim();
    const cleaned = base.replace(/[\/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').slice(0, max).trim();
    return cleaned || 'untitled';
  }

  function base64ToUtf8(b64) {
    try {
      // atob -> binary string -> Uint8Array -> TextDecoder
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      try {
        // fallback: decodeURIComponent(escape(atob())) — not perfect but may help
        return decodeURIComponent(escape(atob(b64)));
      } catch (_) {
        return null;
      }
    }
  }

  async function downloadText(content, filename, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      if (typeof GM_download === 'function') {
        await new Promise((resolve, reject) => {
          GM_download({ url, name: filename, ontimeout: reject, timeout: 60_000, onerror: reject, onload: resolve, saveAs: false });
        });
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function downloadBlob(blob, filename) {
    // 使用 a[download] 触发下载；部分管理器对 blob: URL 支持不佳，避免 GM_download 造成卡住
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延迟 revoke，确保浏览器已接手下载
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function fetchJson(url) {
    // 不设置任何额外认证请求头；沿用浏览器会话（Cookie 等由浏览器自动处理）
    const resp = await fetchWithRetry(
      url,
      { credentials: "same-origin" },
      { retries: 4, baseDelay: 600, maxDelay: 8000, autoBackoff: true }
    );
    return resp.json();
  }

  async function paginateList(
    initialUrl,
    maxPages = 9999,
    delayMs = 220,
    maxTotal = Infinity
  ) {
    let results = [];
    let page = 0;
    let url = new URL(initialUrl);
    const qp = url.searchParams;
    let limit = parseInt(qp.get("limit") || "50", 10);
    let offset = parseInt(qp.get("offset") || "0", 10);

    while (page < maxPages) {
      const remaining = Math.max(0, maxTotal - results.length);
      if (remaining <= 0) break;
      const pageLimit = Math.max(1, Math.min(limit, remaining));
      const pageUrl = setUrlParam(
        setUrlParam(url.toString(), "limit", pageLimit),
        "offset",
        offset
      );
      const data = await fetchJson(pageUrl);
      const arr = guessArrayPayload(data);
      if (!arr.length) break;
      results = results.concat(arr);
      if (arr.length < pageLimit || results.length >= maxTotal) break;
      offset += pageLimit;
      page += 1;
      if (delayMs) await sleep(delayMs);
    }
    return { items: results, limit, lastOffset: offset };
  }

  // ============ UI ============
  function createPanel() {
    if (document.getElementById("pplx-export-panel")) return;
    const panel = document.createElement("div");
    panel.id = "pplx-export-panel";
    panel.className = "pplx-export-fab";
    panel.innerHTML = `
      <div><strong>导出 PPLX 集合</strong></div>
      <div class="pplx-export-row">
        <input id="pplx-url" type="text" placeholder="粘贴 list_collection_threads 接口完整 URL" />
      </div>
      <div class="pplx-export-row">
        <input id="pplx-slug" type="text" placeholder="可选：collection_slug（若留空则不自动拼 URL）" />
      </div>
      <div class="pplx-export-row">
        <input id="pplx-limit" type="number" min="1" max="200" value="50" />
      </div>
      <div class="pplx-export-row">
        <label style="display:flex;align-items:center;gap:6px;">
          <input id="pplx-with-md" type="checkbox" checked /> 同时获取每条对话的 Markdown
        </label>
      </div>
      <div class="pplx-export-row">
        <label style="display:flex;align-items:center;gap:6px;">
          每条请求间隔(ms)：<input id="pplx-delay" type="number" min="0" max="60000" value="800" />
        </label>
        <label style="display:flex;align-items:center;gap:6px;">
          <input id="pplx-auto-backoff" type="checkbox" checked /> 429 自动退避
        </label>
      </div>
      <div class="pplx-export-row">
        <label style="display:flex;align-items:center;gap:6px;">
          <input id="pplx-save-md-files" type="checkbox" /> 导出为多个 .md 文件
        </label>
        <label style="display:flex;align-items:center;gap:6px;">
          <input id="pplx-merge-md" type="checkbox" /> 合并为一个 .md
        </label>
      </div>
      <div class="pplx-export-row">
        <button id="pplx-run">抓取并下载 JSON</button>
      </div>
      <div class="pplx-export-note">
        使用方法：
        <br/>1) 直接粘贴接口 URL，或只填 collection_slug。
        <br/>2) 脚本会自动分页抓取并导出 JSON。
        <br/>3) 可选：勾选“同时获取 Markdown”，逐条抓取每个线程的 MD。
        <br/>4) 可选：导出为多个/合并为一个 .md 文件。
        <br/>无需设置认证请求头（沿用网页会话）。
      </div>
    `;

    document.body.appendChild(panel);

    const urlInput = panel.querySelector("#pplx-url");
    const slugInput = panel.querySelector("#pplx-slug");
    const limitInput = panel.querySelector("#pplx-limit");
    const offsetInput = panel.querySelector("#pplx-offset");
    const withMdInput = panel.querySelector("#pplx-with-md");
    const delayInput = panel.querySelector("#pplx-delay");
    const autoBackoffInput = panel.querySelector("#pplx-auto-backoff");
    const saveMdFilesInput = panel.querySelector("#pplx-save-md-files");
    const mergeMdInput = panel.querySelector("#pplx-merge-md");
    const runBtn = panel.querySelector("#pplx-run");

    // 恢复已保存的 collection_slug；无保存时再尝试从当前页 URL 猜测
    try {
      const savedSlug = store.get('pplx_slug', '');
      if (savedSlug) {
        slugInput.value = savedSlug;
      } else {
        const guessSlug = extractCollectionSlugFromUrl(location.href);
        if (guessSlug) slugInput.value = guessSlug;
      }
    } catch (_) {}
    // 恢复历史设置
    try {
      const savedMax = store.get('pplx_max_count', '');
      if (maxCountInput && savedMax !== '' && savedMax != null) maxCountInput.value = String(savedMax);
      const savedPart = store.get('pplx_part_size', 50);
      if (partSizeInput && Number.isFinite(savedPart)) partSizeInput.value = String(savedPart);
      const savedOffset = store.get('pplx_offset', 0);
      if (offsetInput && Number.isFinite(savedOffset)) offsetInput.value = String(savedOffset);
      const savedLimit = store.get('pplx_limit', 50);
      if (limitInput && Number.isFinite(savedLimit)) limitInput.value = String(savedLimit);
      const savedDelay = store.get('pplx_delay', 800);
      if (delayInput && Number.isFinite(savedDelay)) delayInput.value = String(savedDelay);
    } catch (_) {}

    // 提供一个示例 URL，方便快速上手
    if (!urlInput.value) {
      urlInput.placeholder =
        "例如: https://www.perplexity.ai/rest/collections/list_collection_threads?collection_slug=YOUR_SLUG&limit=50&filter_by_user=true&filter_by_shared_threads=false&offset=0&version=2.18&source=default";
    }

    runBtn.addEventListener("click", async () => {
      try {
        runBtn.disabled = true;
        runBtn.textContent = "抓取中…";

        let finalUrl = urlInput.value.trim();
        const slug = slugInput.value.trim();
        const limit = Math.max(
          1,
          Math.min(200, parseInt(limitInput.value || "50", 10))
        );
        const offsetStart = Math.max(
          0,
          parseInt(offsetInput?.value || "0", 10) || 0
        );
        // 保存设置
        try {
          store.set('pplx_slug', slug);
          store.set('pplx_limit', limit);
          store.set('pplx_offset', offsetStart);
          const dly = Math.max(0, parseInt(delayInput.value || '800', 10) || 0);
          store.set('pplx_delay', dly);
        } catch (_) {}

        if (!finalUrl && slug) {
          // 自动拼接接口 URL
          const base =
            "https://www.perplexity.ai/rest/collections/list_collection_threads";
          const u = new URL(base);
          u.searchParams.set("collection_slug", slug);
          u.searchParams.set("limit", String(limit));
          u.searchParams.set("filter_by_user", "true");
          u.searchParams.set("filter_by_shared_threads", "false");
          u.searchParams.set("offset", String(offsetStart));
          u.searchParams.set("version", "2.18");
          u.searchParams.set("source", "default");
          finalUrl = u.toString();
        }

        const valid = parseUrl(finalUrl);
        if (!valid) {
          alert("请粘贴有效的接口 URL，或填写 collection_slug 以自动拼接 URL");
          return;
        }

        // 强制使用用户指定的 limit 与 offset 起点
        finalUrl = setUrlParam(finalUrl, "limit", limit);
        finalUrl = setUrlParam(finalUrl, "offset", offsetStart);

        const { items, lastOffset } = await paginateList(finalUrl, 9999, 220);

        const urlForParams = new URL(finalUrl);
        const apiVersion = urlForParams.searchParams.get("version") || "2.18";
        const apiSource = urlForParams.searchParams.get("source") || "default";

        let enriched = items;
        if (
          withMdInput.checked ||
          saveMdFilesInput.checked ||
          mergeMdInput.checked
        ) {
          const total = items.length;
          const delayPer = Math.max(
            0,
            parseInt(delayInput.value || "800", 10) || 0
          );
          const mdEndpoint = "https://www.perplexity.ai/rest/thread/export";

          const getThreadId = (item) => {
            const candidates = [
              "thread_id",
              "threadId",
              "id",
              "uuid",
              "thread_uuid",
            ];
            for (const k of candidates) {
              if (item && k in item && item[k]) return String(item[k]);
            }
            if (item && item.thread && item.thread.id)
              return String(item.thread.id);
            return null;
          };

          const fetchThreadMarkdown = async (threadId) => {
            if (!threadId) return null;
            const u = new URL(mdEndpoint);
            u.searchParams.set("version", apiVersion);
            u.searchParams.set("source", apiSource);

            const bodies = [
              // 首选：新接口要求的字段
              { thread_uuid: threadId, format: "md" },
            ];

            for (let i = 0; i < bodies.length; i++) {
              try {
                const resp = await fetchWithRetry(
                  u.toString(),
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(bodies[i]),
                    credentials: "same-origin",
                  },
                  {
                    retries: 6,
                    baseDelay: Math.max(600, delayPer || 600),
                    maxDelay: 40000, // 最多 40 秒
                    autoBackoff: !!autoBackoffInput.checked,
                  }
                );
                const ct = resp.headers.get("content-type") || "";
                if (ct.includes("application/json")) {
                  const j = await resp.json();
                  if (typeof j === "string") return { markdown: j };

                  // 1) file_content_64 模式
                  const fc64 = j?.file_content_64 || j?.data?.file_content_64;
                  if (fc64 && typeof fc64 === "string") {
                    const md = base64ToUtf8(fc64);
                    const filename = j?.filename || j?.data?.filename || null;
                    if (md) return { markdown: md, filename };
                  }

                  // 2) 直接字符串字段
                  for (const k of ["markdown", "content", "text"]) {
                    if (j && typeof j[k] === "string")
                      return { markdown: j[k] };
                  }
                  if (j && j.data && typeof j.data.markdown === "string")
                    return { markdown: j.data.markdown };

                  // 3) 兜底：字符串化
                  try {
                    return { markdown: JSON.stringify(j) };
                  } catch {
                    return { markdown: String(j) };
                  }
                } else {
                  const t = await resp.text();
                  return { markdown: t };
                }
              } catch (_) {
                /* 下一种 body 变体 */
              }
            }
            return null;
          };

          // merged markdown accumulator
          let mergedMd = "";
          // precompute slug for checkpoint filenames
          const nameSlugForMd =
            new URL(finalUrl).searchParams.get("collection_slug") ||
            "collection";
          for (let i = 0; i < enriched.length; i++) {
            const it = enriched[i];
            const id = getThreadId(it);
            runBtn.textContent = `获取 Markdown ${i + 1}/${total}…`;
            try {
              const res = await fetchThreadMarkdown(id);
              const md = res?.markdown || null;
              const providedName = res?.filename
                ? safeFilename(res.filename)
                : null;
              if (withMdInput.checked) it.markdown = md;

              const title =
                providedName ||
                safeFilename(it.title || it.slug || id || `thread_${i + 1}`);
              if (saveMdFilesInput.checked && md) {
                const filename = title.endsWith(".md") ? title : `${title}.md`;
                await downloadText(md, filename, "text/markdown;charset=utf-8");
              }
              if (mergeMdInput.checked && md) {
                mergedMd += `# ${title}\n\n` + md + `\n\n---\n\n`;
                // 每下载 50 条，保存一次检查点，避免意外丢失进度
                if ((i + 1) % 50 === 0) {
                  try {
                    await downloadText(
                      mergedMd,
                      `pplx_${nameSlugForMd}_merged_checkpoint_${i + 1}.md`,
                      "text/markdown;charset=utf-8"
                    );
                  } catch (_) {
                    // ignore checkpoint save errors and continue
                  }
                }
              }
            } catch (e) {
              console.warn("[PPLX Export] markdown failed for", id, e);
              it.markdown = null;
            }
            if (delayPer) await sleep(delayPer);
          }
          if (mergeMdInput.checked && mergedMd) {
            await downloadText(
              mergedMd,
              `pplx_${nameSlugForMd}_merged.md`,
              "text/markdown;charset=utf-8"
            );
          }
        }

        const payload = {
          meta: {
            fetchedAt: new Date().toISOString(),
            total: items.length,
            lastOffset,
            source: location.href,
            endpoint: finalUrl,
            withMarkdown: !!withMdInput.checked,
            exportedMdFiles: !!saveMdFilesInput.checked,
            mergedMd: !!mergeMdInput.checked,
            version: apiVersion,
            apiSource,
          },
          items: enriched,
        };

        const nameSlug =
          new URL(finalUrl).searchParams.get("collection_slug") || "collection";
        const filename = `pplx_${nameSlug}_threads_${items.length}${
          withMdInput.checked ? "_with_md" : ""
        }.json`;
        downloadObjectAsJson(payload, filename);

        runBtn.textContent = "完成，已下载 JSON";
      } catch (err) {
        console.error("[PPLX Export] Error:", err);
        alert("抓取失败：" + (err && err.message ? err.message : String(err)));
      } finally {
        setTimeout(() => {
          runBtn.disabled = false;
          runBtn.textContent = "抓取并下载 JSON";
        }, 1600);
      }
    });

    // 更稳的自动续跑：确保监听已绑定后再尝试点击，最多尝试 3 秒
    try {
      if (store.get('pplx_run_after_reload', false)) {
        store.set('pplx_run_after_reload', false);
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          try {
            if (!document.body.contains(runBtn)) { clearInterval(timer); return; }
            if (runBtn.disabled) { clearInterval(timer); return; }
            runBtn.click();
          } catch (_) {}
          if (runBtn.disabled || tries >= 15) {
            clearInterval(timer);
          }
        }, 200);
      }
    } catch (_) {}
  }

  function ready(fn) {
    if (
      document.readyState === "complete" ||
      document.readyState === "interactive"
    ) {
      fn();
    } else {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    }
  }

  // 仅保留 ZIP 导出模式的新面板
  function createPanelZipOnly() {
    if (document.getElementById("pplx-export-panel")) return;
    const panel = document.createElement("div");
    panel.id = "pplx-export-panel";
    panel.className = "pplx-export-fab";
    panel.innerHTML = `
      <div><strong>导出 Markdown ZIP</strong></div>
      <div class="pplx-export-row">
        <input id="pplx-url" type="text" placeholder="粘贴 list_collection_threads 接口完整 URL" />
      </div>
      <div class="pplx-export-row">
        <input id="pplx-slug" type="text" placeholder="可选：collection_slug（留空则不自动拼 URL）" />
      </div>
      <div class="pplx-export-row">
        <label style="display:flex;align-items:center;gap:6px;">每页条数
          <input id="pplx-limit" type="number" min="1" max="200" value="50" />
        </label>
      </div>
      <div class="pplx-export-row">
        <label style="display:flex;align-items:center;gap:6px;">起始 offset
          <input id="pplx-offset" type="number" min="0" step="1" value="0" />
        </label>
      </div>
      <div class="pplx-export-row">
        <label style="display:flex;align-items:center;gap:6px;">最大导出数（留空为全部）
          <input id="pplx-max-count" type="number" min="1" step="1" placeholder="全部" />
        </label>
      </div>
      <div class="pplx-export-row">
        <label style="display:flex;align-items:center;gap:6px;">分卷大小（每卷条数）
          <input id="pplx-part-size" type="number" min="1" max="100" value="50" />
        </label>
      </div>
      <div class="pplx-export-row">
        <label style="display:flex;align-items:center;gap:6px;">请求间隔(ms)
          <input id="pplx-delay" type="number" min="0" max="60000" value="800" />
        </label>
        <label style="display:inline-flex;align-items:center;gap:6px;margin-left:8px;">
          <input id="pplx-auto-backoff" type="checkbox" checked /> 429 自动退避
        </label>
      </div>
      <div class="pplx-export-row">
        <button id="pplx-run">导出 ZIP</button>
      </div>
      <div class="pplx-export-note">说明：仅导出为 ZIP（UTF-8）</div>`;

    document.body.appendChild(panel);

    const urlInput = panel.querySelector("#pplx-url");
    const slugInput = panel.querySelector("#pplx-slug");
    const limitInput = panel.querySelector("#pplx-limit");
    const offsetInput = panel.querySelector("#pplx-offset");
    const maxCountInput = panel.querySelector("#pplx-max-count");
    const partSizeInput = panel.querySelector("#pplx-part-size");
    const delayInput = panel.querySelector("#pplx-delay");
    const autoBackoffInput = panel.querySelector("#pplx-auto-backoff");
    const runBtn = panel.querySelector("#pplx-run");

    // 恢复历史设置，便于刷新后继续（ZIP 模式）
    try {
      const savedMax = store.get('pplx_max_count', '');
      if (maxCountInput && savedMax !== '' && savedMax != null) maxCountInput.value = String(savedMax);
      const savedPart = store.get('pplx_part_size', 50);
      if (partSizeInput && Number.isFinite(savedPart)) partSizeInput.value = String(savedPart);
      const savedOffset = store.get('pplx_offset', 0);
      if (offsetInput && Number.isFinite(savedOffset)) offsetInput.value = String(savedOffset);
      const savedLimit = store.get('pplx_limit', 50);
      if (limitInput && Number.isFinite(savedLimit)) limitInput.value = String(savedLimit);
      const savedDelay = store.get('pplx_delay', 800);
      if (delayInput && Number.isFinite(savedDelay)) delayInput.value = String(savedDelay);
      const savedSlug = store.get('pplx_slug', '');
      if (savedSlug) slugInput.value = savedSlug;
    } catch (_) {}

    // 刷新后自动续跑（ZIP 模式）由文末“更稳的自动续跑（ZIP）”统一处理

    // 记忆“最大导出数”的更改（ZIP 模式）
    try {
      if (maxCountInput) {
        maxCountInput.addEventListener('change', () => {
          const raw = parseInt(maxCountInput.value || '', 10);
          store.set('pplx_max_count', Number.isFinite(raw) && raw > 0 ? raw : '');
        });
      }
    } catch (_) {}

    try {
      if (!slugInput.value) {
        const guessSlug = extractCollectionSlugFromUrl(location.href);
        if (guessSlug) slugInput.value = guessSlug;
      }
    } catch (_) {}
    if (!urlInput.value) {
      urlInput.placeholder =
        "例如: https://www.perplexity.ai/rest/collections/list_collection_threads?collection_slug=YOUR_SLUG&limit=50&filter_by_user=true&filter_by_shared_threads=false&offset=0&version=2.18&source=default";
    }

    // slug 输入改变时即刻记忆
    try { slugInput.addEventListener('change', () => { store.set('pplx_slug', slugInput.value.trim()); }); } catch (_) {}

    runBtn.addEventListener("click", async () => {
      try {
        runBtn.disabled = true;
        runBtn.textContent = "抓取中…";

        let finalUrl = urlInput.value.trim();
        const slug = slugInput.value.trim();
        const limit = Math.max(
          1,
          Math.min(200, parseInt(limitInput.value || "50", 10))
        );
        const offsetStart = Math.max(
          0,
          parseInt(offsetInput?.value || "0", 10) || 0
        );
        const partSizeRaw = parseInt(partSizeInput?.value || '50', 10);
        const partSize = Math.max(1, Math.min(100, Number.isFinite(partSizeRaw) ? partSizeRaw : 50));
        const refreshEvery = 10; // 每导出 10 条自动刷新页面
        // 保存当前设置，刷新后可恢复
        try {
          store.set('pplx_slug', slug);
          const dly = Math.max(0, parseInt(delayInput.value || '800', 10) || 0);
          store.set('pplx_delay', dly);
          store.set('pplx_limit', limit);
          store.set('pplx_offset', offsetStart);
          store.set('pplx_part_size', partSize);
        } catch (_) {}
        if (!finalUrl && slug) {
          const base =
            "https://www.perplexity.ai/rest/collections/list_collection_threads";
          const u = new URL(base);
          u.searchParams.set("collection_slug", slug);
          u.searchParams.set("limit", String(limit));
          u.searchParams.set("filter_by_user", "true");
          u.searchParams.set("filter_by_shared_threads", "false");
          u.searchParams.set("offset", String(offsetStart));
          u.searchParams.set("version", "2.18");
          u.searchParams.set("source", "default");
          finalUrl = u.toString();
        }
        const valid = parseUrl(finalUrl);
        if (!valid) {
          alert("请粘贴有效的接口 URL，或填写 collection_slug 自动拼接 URL");
          return;
        }
        finalUrl = setUrlParam(finalUrl, "limit", limit);
        finalUrl = setUrlParam(finalUrl, "offset", offsetStart);

        const maxCountRaw = parseInt(maxCountInput?.value || "", 10);
        const maxCount =
          Number.isFinite(maxCountRaw) && maxCountRaw > 0
            ? maxCountRaw
            : Infinity;
        try {
          store.set(
            "pplx_max_count",
            Number.isFinite(maxCountRaw) && maxCountRaw > 0 ? maxCountRaw : ""
          );
          store.set('pplx_part_size', partSize);
        } catch (_) {}
        const { items } = await paginateList(finalUrl, 9999, 220, maxCount);

        const urlForParams = new URL(finalUrl);
        const apiVersion = urlForParams.searchParams.get("version") || "2.18";
        const apiSource = urlForParams.searchParams.get("source") || "default";

        if (!(window.zip && typeof zip.ZipWriter === 'function')) {
          alert('zip.js 未加载，无法打包 ZIP。');
          return;
        }
        let zipWriter = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
        const used = new Set();
        const pad = (n, w) => String(n).padStart(w, "0");
        const effectiveTotal = items.length;
        const digits = String(offsetStart + effectiveTotal).length;
        const mdEndpoint = "https://www.perplexity.ai/rest/thread/export";
        const delayPer = Math.max(
          0,
          parseInt(delayInput.value || "800", 10) || 0
        );

        const getThreadId = (item) => {
          const candidates = [
            "thread_id",
            "threadId",
            "id",
            "uuid",
            "thread_uuid",
          ];
          for (const k of candidates) {
            if (item && k in item && item[k]) return String(item[k]);
          }
          if (item && item.thread && item.thread.id)
            return String(item.thread.id);
          return null;
        };

        const fetchThreadMarkdown = async (threadId) => {
          if (!threadId) return null;
          const u = new URL(mdEndpoint);
          u.searchParams.set("version", apiVersion);
          u.searchParams.set("source", apiSource);
          const bodies = [{ thread_uuid: threadId, format: "md" }];
          for (let i = 0; i < bodies.length; i++) {
            try {
              const resp = await fetchWithRetry(
                u.toString(),
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(bodies[i]),
                  credentials: "same-origin",
                },
                {
                  retries: 6,
                  baseDelay: Math.max(600, delayPer || 600),
                  maxDelay: 20000,
                  autoBackoff: !!autoBackoffInput.checked,
                }
              );
              const ct = resp.headers.get("content-type") || "";
              if (ct.includes("application/json")) {
                const j = await resp.json();
                if (typeof j === "string") return { markdown: j };
                const fc64 = j?.file_content_64 || j?.data?.file_content_64;
                if (fc64 && typeof fc64 === "string") {
                  const md = base64ToUtf8(fc64);
                  const filename = j?.filename || j?.data?.filename || null;
                  if (md) return { markdown: md, filename };
                }
                for (const k of ["markdown", "content", "text"]) {
                  if (j && typeof j[k] === "string") return { markdown: j[k] };
                }
                if (j && j.data && typeof j.data.markdown === "string")
                  return { markdown: j.data.markdown };
                try {
                  return { markdown: JSON.stringify(j) };
                } catch {
                  return { markdown: String(j) };
                }
              } else {
                const t = await resp.text();
                return { markdown: t };
              }
            } catch (_) {}
          }
          return null;
        };

        const nameSlug =
          new URL(finalUrl).searchParams.get("collection_slug") || "collection";
        const uniqueName = (base) => {
          let n = base;
          let idx = 2;
          while (used.has(n)) n = `${base} (${idx++})`;
          used.add(n);
          return n;
        };

        let partIndex = 1;
        let inPartCount = 0;

        const flushPart = async () => {
          if (inPartCount === 0) return;
          runBtn.textContent = `正在打包 ZIP 分卷 ${partIndex}…`;
          // 关闭当前 writer 获取 Blob 并下载，然后开启下一卷 writer
          let blob;
          try {
            blob = await zipWriter.close();
          } catch (e) {
            console.error('[PPLX Export] ZIP 打包失败:', e);
            throw e;
          }
          const partName = `pplx_${nameSlug}_markdown_part_${String(
            partIndex
          ).padStart(3, "0")}.zip`;
          try {
            console.log(
              "[PPLX Export] downloading part",
              partIndex,
              "size=",
              blob.size
            );
          } catch {}
          // 自动触发 + 手动备用链接，避免浏览器阻止多文件下载导致无响应
          const url = URL.createObjectURL(blob);
          try {
            const manual = document.createElement('a');
            manual.href = url;
            manual.download = partName;
            manual.textContent = `点击保存分卷 ${partIndex}`;
            manual.style.cssText = 'display:inline-block;margin-top:6px;color:#93c5fd;text-decoration:underline;';
            const noteWrap = document.createElement('div');
            noteWrap.style.marginTop = '6px';
            noteWrap.appendChild(manual);
            panel.appendChild(noteWrap);

            // 尝试自动点击下载
            const a = document.createElement('a');
            a.href = url;
            a.download = partName;
            document.body.appendChild(a);
            a.click();
            a.remove();

            // 60 秒后自动清理占用（若用户未手动点击）
            setTimeout(() => { try { URL.revokeObjectURL(url); noteWrap.remove(); } catch {} }, 60000);
            // 用户手动点击后立即清理
            manual.addEventListener('click', () => {
              setTimeout(() => { try { URL.revokeObjectURL(url); noteWrap.remove(); } catch {} }, 1500);
            }, { once: true });
          } catch (_) {
            try { URL.revokeObjectURL(url); } catch {}
          }
          partIndex++;
          inPartCount = 0;
          zipWriter = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
        };

        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const id = getThreadId(it);
          runBtn.textContent = `获取 Markdown ${i + 1}/${items.length}…`;
          try {
            const res = await fetchThreadMarkdown(id);
            const md = res?.markdown || "";
            const providedName = res?.filename
              ? safeFilename(res.filename)
              : null;
            const title =
              providedName ||
              safeFilename(it.title || it.slug || id || `thread_${i + 1}`);
            const fname = uniqueName(
              `${pad(offsetStart + i + 1, digits)}_${title}.md`
            );

            if (items.length === 1) {
              try {
                const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const manual = document.createElement('a');
                manual.href = url;
                manual.download = fname;
                manual.textContent = `点击保存 ${fname}`;
                manual.style.cssText = 'display:inline-block;margin-top:6px;color:#93c5fd;text-decoration:underline;';
                const noteWrap = document.createElement('div');
                noteWrap.style.marginTop = '6px';
                noteWrap.appendChild(manual);
                panel.appendChild(noteWrap);

                const a = document.createElement('a');
                a.href = url;
                a.download = fname;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => { try { URL.revokeObjectURL(url); noteWrap.remove(); } catch {} }, 60000);
                manual.addEventListener('click', () => {
                  setTimeout(() => { try { URL.revokeObjectURL(url); noteWrap.remove(); } catch {} }, 1500);
                }, { once: true });
                runBtn.textContent = '完成，已下载 .md';
              } catch (e) {
                console.error('[PPLX Export] 单条 .md 下载失败:', e);
              }
              return; // 单条直接结束，不进入 ZIP
            }

            // 将文件写入当前分卷（level=0 使用 STORE，无压缩更快更稳）
            await zipWriter.add(
              fname,
              new zip.TextReader(md),
              {
                level: 0,
                onprogress: (loaded, total) => {
                  try {
                    let percent = 0;
                    if (typeof loaded === 'number' && typeof total === 'number' && total > 0) {
                      percent = Math.floor((loaded / total) * 100);
                    } else if (loaded && typeof loaded.loaded === 'number' && typeof loaded.total === 'number' && loaded.total > 0) {
                      percent = Math.floor((loaded.loaded / loaded.total) * 100);
                    }
                    runBtn.textContent = `写入 ${fname} ${percent}%…`;
                  } catch {}
                }
              }
            );
            inPartCount++;

            // 每导出 N 条，保存进度并刷新页面以续跑
            if (((i + 1) % refreshEvery === 0) && (i + 1) < items.length) {
              try {
                // 刷新前尽量落盘当前分卷
                await flushPart();
              } catch (_) {}
              try {
                const nextOffset = offsetStart + i + 1;
                store.set('pplx_offset', nextOffset);
                store.set('pplx_run_after_reload', true);
                store.set('pplx_part_size', partSize);
                // 轻微延迟，给下载触发时间
                setTimeout(() => { location.reload(); }, 500);
                return; // 结束当前任务，等待刷新后续跑
              } catch (_) {
                // 如果存储失败则不中断流程
              }
            }
          } catch (e) {
            console.warn("[PPLX Export] markdown failed for", id, e);
          }
          if (delayPer) await sleep(delayPer);

          // 每 50 条导出一个分卷
          if ((i + 1) % partSize === 0) {
            await flushPart();
          }
        }

        // 导出剩余未满分卷大小的分卷
        await flushPart();
        runBtn.textContent = "完成，已下载 ZIP 分卷";
      } catch (err) {
        console.error("[PPLX Export] Error:", err);
        alert("抓取失败：" + (err && err.message ? err.message : String(err)));
      } finally {
        setTimeout(() => {
          runBtn.disabled = false;
          runBtn.textContent = "导出 ZIP";
        }, 1600);
      }
    });

    // 更稳的自动续跑（ZIP）：监听已绑定后再尝试点击，最多尝试 3 秒
    try {
      if (store.get('pplx_run_after_reload', false)) {
        store.set('pplx_run_after_reload', false);
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          try {
            if (!document.body.contains(runBtn)) { clearInterval(timer); return; }
            if (runBtn.disabled) { clearInterval(timer); return; }
            runBtn.click();
          } catch (_) {}
          if (runBtn.disabled || tries >= 15) {
            clearInterval(timer);
          }
        }, 200);
      }
    } catch (_) {}
  }

  ready(createPanelZipOnly);
})();
