/* DSH Link · 极简 Markdown 渲染器（零依赖）
 *
 * 只覆盖对话里真正会出现的语法：标题、段落、列表、引用、代码块、行内代码、
 * 表格、分割线、加粗/斜体/删除线、链接与裸 URL。
 *
 * 安全约定：**所有**来自会话的文本都先 escapeHtml 再进模板；唯一未经转义
 * 输出的字符串是本模块自己生成的标签。因此可以直接 innerHTML。
 * 链接只放行 http/https/mailto 与相对路径，`javascript:` 之类会被丢掉。
 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** 只允许安全协议；返回空串表示不可用。 */
export function sanitizeUrl(raw) {
  const url = String(raw ?? "").trim();
  if (!url) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /^(https?:|mailto:)/i.test(url) ? url : "";
  if (url.startsWith("//")) return "";
  return url;
}

const LINK_ATTR = ' target="_blank" rel="noopener noreferrer"';

/* ─────────────────────── 行内 ─────────────────────── */

/** 行内语法。输入是**原始**文本，输出是安全 HTML。 */
export function renderInline(raw) {
  const src = String(raw ?? "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;

    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      out += `<code>${escapeHtml(m[1])}</code>`;
      i += m[0].length;
      continue;
    }
    if ((m = /^!\[([^\]\n]*)\]\(([^)\s]*)\)/.exec(rest))) {
      // 图片不加载远端资源（内网、隐私），降级成链接文本
      const href = sanitizeUrl(m[2]);
      out += href ? `<a href="${escapeHtml(href)}"${LINK_ATTR}>${escapeHtml(m[1] || m[2])}</a>` : escapeHtml(m[1]);
      i += m[0].length;
      continue;
    }
    if ((m = /^\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest))) {
      const href = sanitizeUrl(m[2]);
      out += href
        ? `<a href="${escapeHtml(href)}"${LINK_ATTR}>${renderInline(m[1])}</a>`
        : renderInline(m[1]);
      i += m[0].length;
      continue;
    }
    if ((m = /^https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?]/.exec(rest))) {
      out += `<a href="${escapeHtml(m[0])}"${LINK_ATTR}>${escapeHtml(m[0])}</a>`;
      i += m[0].length;
      continue;
    }
    if ((m = /^\*\*([^*]+)\*\*/.exec(rest)) || (m = /^__([^_]+)__/.exec(rest))) {
      out += `<strong>${renderInline(m[1])}</strong>`;
      i += m[0].length;
      continue;
    }
    if ((m = /^~~([^~]+)~~/.exec(rest))) {
      out += `<del>${renderInline(m[1])}</del>`;
      i += m[0].length;
      continue;
    }
    if ((m = /^\*([^*\n]+)\*/.exec(rest)) || (m = /^_([^_\n]+)_/.exec(rest))) {
      out += `<em>${renderInline(m[1])}</em>`;
      i += m[0].length;
      continue;
    }

    if (rest[0] === "\n") { out += "<br>"; i += 1; continue; }

    // 普通文本：一次性吃到下一个特殊字符
    const stop = rest.slice(1).search(/[`\[*_~<\n]|https?:\/\//);
    const len = stop < 0 ? rest.length : stop + 1;
    out += escapeHtml(rest.slice(0, len));
    i += len;
  }
  return out;
}

/* ─────────────────────── 块级 ─────────────────────── */

const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([^`]*)$/;
const RE_HR = /^\s*(?:[-*_]\s*){3,}$/;
const RE_HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function renderTable(head, rows) {
  const th = head.map((c) => `<th>${renderInline(c)}</th>`).join("");
  const tb = rows
    .map((r) => `<tr>${head.map((_, i) => `<td>${renderInline(r[i] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

function renderCode(lang, code) {
  const label = escapeHtml((lang || "").trim().split(/\s+/)[0] || "text");
  return (
    `<div class="md-code">` +
    `<div class="md-code-head"><span class="md-lang">${label}</span>` +
    `<button type="button" class="md-copy" data-copy="${escapeHtml(code)}">复制</button></div>` +
    `<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>` +
    `</div>`
  );
}

/** 连续的列表项 → 嵌套 <ul>/<ol>。缩进每 2 空格算一层。 */
function renderList(lines, start) {
  const parts = [];
  const stack = []; // {depth, ordered}
  let i = start;

  const closeTo = (depth) => {
    while (stack.length > 1 && stack[stack.length - 1].depth > depth) {
      const top = stack.pop();
      parts.push(`</li></${top.ordered ? "ol" : "ul"}>`);
    }
  };
  const appendToLastItem = (text) => {
    const last = parts.length - 1;
    // 上一个元素总是尚未闭合的 `<li>…`
    if (last >= 0 && parts[last].startsWith("<li>") && !parts[last].endsWith("</li>")) {
      parts[last] += ` ${renderInline(text)}`;
    }
  };

  while (i < lines.length) {
    const m = RE_ITEM.exec(lines[i]);
    if (!m) {
      // 惰性续行：缩进的普通行并进上一个条目
      if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && stack.length) {
        appendToLastItem(lines[i].trim());
        i += 1;
        continue;
      }
      break;
    }
    const depth = m[1].replace(/\t/g, "    ").length;
    const ordered = /^\d/.test(m[2]);

    if (!stack.length) {
      stack.push({ depth, ordered });
      parts.push(ordered ? "<ol>" : "<ul>");
    } else {
      closeTo(depth);
      const top = stack[stack.length - 1];
      if (depth > top.depth) {
        stack.push({ depth, ordered });
        parts.push(ordered ? "<ol>" : "<ul>");
      } else if (depth === top.depth) {
        if (ordered !== top.ordered) {
          stack.pop();
          parts.push(`</li></${top.ordered ? "ol" : "ul"}>`);
          stack.push({ depth, ordered });
          parts.push(ordered ? "<ol>" : "<ul>");
        } else {
          parts.push("</li>");
        }
      } else {
        // 缩进回退到某一层但不精确匹配：按当前层继续
        parts.push("</li>");
      }
    }
    parts.push(`<li>${renderInline(m[3])}`);
    i += 1;
  }
  while (stack.length) {
    const top = stack.pop();
    parts.push(`</li></${top.ordered ? "ol" : "ul"}>`);
  }
  return { html: parts.join(""), next: i };
}

/**
 * 把 Markdown 渲染成安全 HTML。
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾 fence（缺失时正好跳过下一行，无副作用）
      out.push(renderCode(fence[2], body.join("\n")));
      continue;
    }

    if (RE_HR.test(line) && !RE_ITEM.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    const head = RE_HEAD.exec(line);
    if (head) {
      const n = head[1].length;
      out.push(`<h${n}>${renderInline(head[2])}</h${n}>`);
      i += 1;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && (RE_QUOTE.test(lines[i]) || (body.length && lines[i].trim()))) {
        const q = RE_QUOTE.exec(lines[i]);
        body.push(q ? q[1] : lines[i]);
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    if (RE_ITEM.test(line)) {
      const { html, next } = renderList(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(head, rows));
      continue;
    }

    // 段落：吃到空行或下一个块级起点
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (para.length && (RE_FENCE.test(l) || RE_HEAD.test(l) || RE_HR.test(l) || RE_QUOTE.test(l) || RE_ITEM.test(l))) break;
      if (para.length && l.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) break;
      para.push(l);
      i += 1;
    }
    out.push(`<p>${renderInline(para.join("\n"))}</p>`);
  }

  return out.join("");
}
