/**
 * md.js 的自测：Markdown 渲染与转义安全。
 * 运行：node test/md.test.mjs
 */
import { strict as assert } from "node:assert";
import { test, afterAll } from "vitest";
import { renderMarkdown, renderInline, escapeHtml, sanitizeUrl } from "../src/public/md.js";



test("转义 HTML，不产生可执行标签", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&lt;img"), html);
});

test("标题", () => {
  assert.equal(renderMarkdown("# 标题"), "<h1>标题</h1>");
  assert.equal(renderMarkdown("### 三级"), "<h3>三级</h3>");
});

test("段落与换行", () => {
  assert.equal(renderMarkdown("a\nb"), "<p>a<br>b</p>");
  assert.equal(renderMarkdown("a\n\nb"), "<p>a</p><p>b</p>");
});

test("行内代码里的 HTML 被转义", () => {
  const html = renderMarkdown("用 `a<b` 比较");
  assert.ok(html.includes("<code>a&lt;b</code>"), html);
});

test("加粗 / 斜体 / 删除线", () => {
  assert.ok(renderMarkdown("**粗**").includes("<strong>粗</strong>"));
  assert.ok(renderMarkdown("*斜*").includes("<em>斜</em>"));
  assert.ok(renderMarkdown("~~删~~").includes("<del>删</del>"));
});

test("链接放行 http(s)，拦截 javascript:", () => {
  const ok = renderMarkdown("[文档](https://example.com/a?b=1)");
  assert.ok(ok.includes('href="https://example.com/a?b=1"'), ok);
  assert.ok(ok.includes('rel="noopener noreferrer"'), ok);

  const bad = renderMarkdown("[点我](javascript:alert(1))");
  assert.ok(!bad.includes("javascript:"), bad);
  assert.ok(bad.includes("点我"), bad);
});

test("裸 URL 自动成链", () => {
  const html = renderInline("见 https://example.com/x 说明");
  assert.ok(html.includes('<a href="https://example.com/x"'), html);
});

test("围栏代码块带语言与复制载荷", () => {
  const html = renderMarkdown("```js\nconst a = 1 < 2;\n```");
  assert.ok(html.includes('class="md-code"'), html);
  assert.ok(html.includes('<span class="md-lang">js</span>'), html);
  assert.ok(html.includes("const a = 1 &lt; 2;"), html);
  assert.ok(html.includes('data-copy="const a = 1 &lt; 2;"'), html);
});

test("未闭合的围栏也能渲染", () => {
  const html = renderMarkdown("```\nabc");
  assert.ok(html.includes("<code>abc</code>"), html);
});

test("无序列表（含嵌套）", () => {
  const html = renderMarkdown("- a\n- b\n  - b1\n- c");
  assert.equal(html, "<ul><li>a</li><li>b<ul><li>b1</li></ul></li><li>c</li></ul>");
});

test("有序列表", () => {
  const html = renderMarkdown("1. 一\n2. 二");
  assert.equal(html, "<ol><li>一</li><li>二</li></ol>");
});

test("列表续行并入上一条", () => {
  const html = renderMarkdown("- 第一行\n  第二行");
  assert.ok(html.includes("第一行 第二行"), html);
});

test("引用块", () => {
  const html = renderMarkdown("> 引用\n> 第二行");
  assert.ok(html.startsWith("<blockquote>"), html);
  assert.ok(html.includes("引用<br>第二行"), html);
});

test("分割线", () => {
  assert.equal(renderMarkdown("---"), "<hr>");
});

test("表格", () => {
  const html = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.ok(html.includes('<table class="md-table">'), html);
  assert.ok(html.includes("<th>A</th>"), html);
  assert.ok(html.includes("<td>2</td>"), html);
});

test("表格单元格里的 HTML 被转义", () => {
  const html = renderMarkdown("| A |\n| --- |\n| <b>x</b> |");
  assert.ok(!html.includes("<b>x</b>"), html);
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"), html);
});

test("sanitizeUrl 拒绝危险协议", () => {
  assert.equal(sanitizeUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeUrl("data:text/html,x"), "");
  assert.equal(sanitizeUrl("//evil.com"), "");
  assert.equal(sanitizeUrl("https://ok.com"), "https://ok.com");
  assert.equal(sanitizeUrl("mailto:a@b.c"), "mailto:a@b.c");
});

test("escapeHtml 覆盖五类字符", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("空输入不抛异常", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
  assert.equal(renderInline(undefined), "");
});

