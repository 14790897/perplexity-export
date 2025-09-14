Perplexity 集合导出（Tampermonkey 用户脚本）

必须使用 UTF-8 编码保存脚本，否则会乱码。

1) 安装
- 安装 Tampermonkey（Chrome/Edge/Firefox）。
- 将 `tampermonkey/pplx-export.user.js` 内容新建为一个脚本保存，或使用 Tampermonkey 的“从文件安装”。

2) 作用
- 在 `https://www.perplexity.ai/*` 右下角插入“导出 PPLX 集合”浮窗。
- 粘贴集合接口 URL 或仅填写 `collection_slug`，自动分页抓取并下载 JSON。
- 可选：勾选“同时获取每条对话的 Markdown”，脚本会调用 `POST /rest/thread/export?version=...&source=...` 逐条拉取 MD 并附加到每个条目的 `markdown` 字段。
- 请求头无需手动设置（沿用网页会话）。

3) 使用步骤
- 打开 Perplexity 页面。
- 浮窗中：
  - 直接粘贴完整接口 URL，或只填 `collection_slug`（脚本会自动拼 URL）。
    示例（请把 YOUR_SLUG 替换成你的集合 slug）：
    `https://www.perplexity.ai/rest/collections/list_collection_threads?collection_slug=YOUR_SLUG&limit=50&filter_by_user=true&filter_by_shared_threads=false&offset=0&version=2.18&source=default`
  - 可选：勾选“同时获取每条对话的 Markdown”。
  - 点击“抓取并下载 JSON”。
- 脚本会按 `limit/offset` 自动分页；若勾选了 MD，则逐条请求 `thread/export` 并附加 `markdown`。最终下载 `pplx_<slug>_threads_<count>[_with_md].json`。

4) 说明与扩展
- 仅使用浏览器原生 `fetch`，不额外设置请求头。
- 若接口返回结构与预期不同，脚本会优先识别 `threads/items/data/list/results` 中的数组；否则选择 JSON 中最长的数组字段导出。
- 若需进一步导出每个线程的逐条消息内容（非导出 Markdown 的整帖），请提供对应“线程详情接口”格式（如 `thread_id` 参数与 URL 模板），可在此脚本基础上扩展二次抓取。
