// ==UserScript==
// @name         Perplexity 导出集合对话 (UTF-8)
// @namespace    https://github.com/yourname/perplexity-export
// @version      0.3.0
// @description  从 Perplexity 集合接口批量抓取列表并导出为 JSON；可选逐条获取 Markdown；可导出为多个/合并单个 .md；无需手动设置认证请求头。
// @author       You
// @match        https://www.perplexity.ai/*
// @grant        GM_addStyle
// @grant        GM_download
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

  async function fetchJson(url) {
    // 不设置任何额外认证请求头；沿用浏览器会话（Cookie 等由浏览器自动处理）
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  async function paginateList(initialUrl, maxPages = 9999, delayMs = 220) {
    let results = [];
    let page = 0;
    let url = new URL(initialUrl);
    const qp = url.searchParams;
    let limit = parseInt(qp.get('limit') || '50', 10);
    let offset = parseInt(qp.get('offset') || '0', 10);

    while (page < maxPages) {
      const pageUrl = setUrlParam(setUrlParam(url.toString(), 'limit', limit), 'offset', offset);
      const data = await fetchJson(pageUrl);
      const arr = guessArrayPayload(data);
      if (!arr.length) break;
      results = results.concat(arr);
      if (arr.length < limit) break;
      offset += limit;
      page += 1;
      if (delayMs) await sleep(delayMs);
    }
    return { items: results, limit, lastOffset: offset };
  }

  // ============ UI ============
  function createPanel() {
    if (document.getElementById('pplx-export-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'pplx-export-panel';
    panel.className = 'pplx-export-fab';
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

    const urlInput = panel.querySelector('#pplx-url');
    const slugInput = panel.querySelector('#pplx-slug');
    const limitInput = panel.querySelector('#pplx-limit');
    const withMdInput = panel.querySelector('#pplx-with-md');
    const saveMdFilesInput = panel.querySelector('#pplx-save-md-files');
    const mergeMdInput = panel.querySelector('#pplx-merge-md');
    const runBtn = panel.querySelector('#pplx-run');

    // 从当前页面猜测 slug（若 URL 中含有 collection_slug）
    try {
      const here = new URL(location.href);
      const guessSlug = here.searchParams.get('collection_slug') || '';
      if (guessSlug) slugInput.value = guessSlug;
    } catch (_) {}

    // 提供一个示例 URL，方便快速上手
    if (!urlInput.value) {
      urlInput.placeholder = '例如: https://www.perplexity.ai/rest/collections/list_collection_threads?collection_slug=YOUR_SLUG&limit=50&filter_by_user=true&filter_by_shared_threads=false&offset=0&version=2.18&source=default';
    }

    runBtn.addEventListener('click', async () => {
      try {
        runBtn.disabled = true;
        runBtn.textContent = '抓取中…';

        let finalUrl = urlInput.value.trim();
        const slug = slugInput.value.trim();
        const limit = Math.max(1, Math.min(200, parseInt(limitInput.value || '50', 10)));

        if (!finalUrl && slug) {
          // 自动拼接接口 URL
          const base = 'https://www.perplexity.ai/rest/collections/list_collection_threads';
          const u = new URL(base);
          u.searchParams.set('collection_slug', slug);
          u.searchParams.set('limit', String(limit));
          u.searchParams.set('filter_by_user', 'true');
          u.searchParams.set('filter_by_shared_threads', 'false');
          u.searchParams.set('offset', '0');
          u.searchParams.set('version', '2.18');
          u.searchParams.set('source', 'default');
          finalUrl = u.toString();
        }

        const valid = parseUrl(finalUrl);
        if (!valid) {
          alert('请粘贴有效的接口 URL，或填写 collection_slug 以自动拼接 URL');
          return;
        }

        // 强制使用用户指定的 limit 与 offset 起点
        finalUrl = setUrlParam(finalUrl, 'limit', limit);
        finalUrl = setUrlParam(finalUrl, 'offset', 0);

        const { items, lastOffset } = await paginateList(finalUrl, 9999, 220);

        const urlForParams = new URL(finalUrl);
        const apiVersion = urlForParams.searchParams.get('version') || '2.18';
        const apiSource = urlForParams.searchParams.get('source') || 'default';

        let enriched = items;
        if (withMdInput.checked || saveMdFilesInput.checked || mergeMdInput.checked) {
          const total = items.length;
          const delayPer = 260; // ms
          const mdEndpoint = 'https://www.perplexity.ai/rest/thread/export';

          const getThreadId = (item) => {
            const candidates = ['thread_id', 'threadId', 'id', 'uuid', 'thread_uuid'];
            for (const k of candidates) {
              if (item && (k in item) && item[k]) return String(item[k]);
            }
            if (item && item.thread && item.thread.id) return String(item.thread.id);
            return null;
          };

          const fetchThreadMarkdown = async (threadId) => {
            if (!threadId) return null;
            const u = new URL(mdEndpoint);
            u.searchParams.set('version', apiVersion);
            u.searchParams.set('source', apiSource);

            const bodies = [
              { thread_id: threadId, type: 'markdown' },
              { id: threadId, type: 'markdown' },
              { threadId: threadId, type: 'markdown' }
            ];

            for (let i = 0; i < bodies.length; i++) {
              try {
                const resp = await fetch(u.toString(), {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(bodies[i]),
                  credentials: 'same-origin'
                });
                if (!resp.ok) continue;
                const ct = resp.headers.get('content-type') || '';
                if (ct.includes('application/json')) {
                  const j = await resp.json();
                  if (typeof j === 'string') return { markdown: j };

                  // 1) file_content_64 模式
                  const fc64 = j?.file_content_64 || j?.data?.file_content_64;
                  if (fc64 && typeof fc64 === 'string') {
                    const md = base64ToUtf8(fc64);
                    const filename = j?.filename || j?.data?.filename || null;
                    if (md) return { markdown: md, filename };
                  }

                  // 2) 直接字符串字段
                  for (const k of ['markdown', 'content', 'text']) {
                    if (j && typeof j[k] === 'string') return { markdown: j[k] };
                  }
                  if (j && j.data && typeof j.data.markdown === 'string') return { markdown: j.data.markdown };

                  // 3) 兜底：字符串化
                  try { return { markdown: JSON.stringify(j) }; } catch { return { markdown: String(j) }; }
                } else {
                  const t = await resp.text();
                  return { markdown: t };
                }
              } catch (_) { /* 下一种 body 变体 */ }
            }
            return null;
          };

          let mergedMd = '';
          for (let i = 0; i < enriched.length; i++) {
            const it = enriched[i];
            const id = getThreadId(it);
            runBtn.textContent = `获取 Markdown ${i + 1}/${total}…`;
            try {
              const res = await fetchThreadMarkdown(id);
              const md = res?.markdown || null;
              const providedName = res?.filename ? safeFilename(res.filename) : null;
              if (withMdInput.checked) it.markdown = md;

              const title = providedName || safeFilename(it.title || it.slug || id || `thread_${i + 1}`);
              if (saveMdFilesInput.checked && md) {
                const filename = title.endsWith('.md') ? title : `${title}.md`;
                await downloadText(md, filename, 'text/markdown;charset=utf-8');
              }
              if (mergeMdInput.checked && md) {
                mergedMd += `# ${title}\n\n` + md + `\n\n---\n\n`;
              }
            } catch (e) {
              console.warn('[PPLX Export] markdown failed for', id, e);
              it.markdown = null;
            }
            if (delayPer) await sleep(delayPer);
          }
          if (mergeMdInput.checked && mergedMd) {
            const nameSlugForMd = (new URL(finalUrl)).searchParams.get('collection_slug') || 'collection';
            await downloadText(mergedMd, `pplx_${nameSlugForMd}_merged.md`, 'text/markdown;charset=utf-8');
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
            apiSource
          },
          items: enriched
        };

        const nameSlug = (new URL(finalUrl)).searchParams.get('collection_slug') || 'collection';
        const filename = `pplx_${nameSlug}_threads_${items.length}${withMdInput.checked ? '_with_md' : ''}.json`;
        downloadObjectAsJson(payload, filename);

        runBtn.textContent = '完成，已下载 JSON';
      } catch (err) {
        console.error('[PPLX Export] Error:', err);
        alert('抓取失败：' + (err && err.message ? err.message : String(err)));
      } finally {
        setTimeout(() => { runBtn.disabled = false; runBtn.textContent = '抓取并下载 JSON'; }, 1600);
      }
    });
  }

  function ready(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    }
  }

  ready(createPanel);
})();
