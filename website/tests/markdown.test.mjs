import assert from "node:assert/strict";
import test from "node:test";

import { renderInline, renderMarkdown, slugify } from "../lib/markdown.mjs";

test("slugs match the anchors GitHub generates, including CJK headings", () => {
  assert.equal(slugify("8. 音频"), "8-音频");
  assert.equal(slugify("15. 支持的 Defold 版本"), "15-支持的-defold-版本");
  assert.equal(slugify("2. Building the HTML5 bundle"), "2-building-the-html5-bundle");
  assert.equal(slugify("minigame.call_sync(api, ...)"), "minigamecall_syncapi");
});

test("inline code is literal; bold and links are rendered and escaped", () => {
  assert.equal(renderInline("use `a < b` and **bold**"), "use <code>a &lt; b</code> and <strong>bold</strong>");
  assert.equal(renderInline("[guide](USAGE.md#x)", (href) => `/r/${href}`), '<a href="/r/USAGE.md#x">guide</a>');
  assert.equal(renderInline("[site](https://example.com/?a=1&b=2)"), '<a href="https://example.com/?a=1&amp;b=2" rel="noopener">site</a>');
  assert.equal(renderInline("<script>"), "&lt;script&gt;");
});

test("headings get ids, duplicate headings get distinct ids, and the outline is collected", () => {
  const headings = [];
  const html = renderMarkdown("# Title\n\n## Setup\n\ntext\n\n## Setup\n", { headings });
  assert.ok(html.includes('<h1 id="title">'));
  assert.ok(html.includes('<h2 id="setup">'));
  assert.ok(html.includes('<h2 id="setup-1">'));
  assert.deepEqual(headings.map((heading) => `${heading.level}:${heading.slug}`), ["1:title", "2:setup", "2:setup-1"]);
});

test("fenced code keeps its text and language, and markup inside it is escaped", () => {
  const html = renderMarkdown("```lua\nif a < b then\n    print(\"**x**\")\nend\n```");
  assert.equal(html, '<pre><code class="language-lua">if a &lt; b then\n    print(&quot;**x**&quot;)\nend</code></pre>');
});

test("tables render header and body, with escaped pipes and pipes inside code", () => {
  const html = renderMarkdown("| Option | Meaning |\n|---|---|\n| `--pixel-ratio <auto\\|n>` | a `b|c` |\n");
  assert.ok(html.includes("<th>Option</th><th>Meaning</th>"));
  assert.ok(html.includes("<td><code>--pixel-ratio &lt;auto|n&gt;</code></td><td>a <code>b|c</code></td>"));
});

test("callouts and block quotes", () => {
  const html = renderMarkdown("> [!WARNING]\n> **Careful.**\n> second line\n\n> plain quote\n");
  assert.ok(html.includes('<div class="callout callout-warning"><p><strong>Careful.</strong> second line</p></div>'));
  assert.ok(html.includes("<blockquote><p>plain quote</p></blockquote>"));
});

test("ordered lists keep nested code blocks and paragraphs inside their items", () => {
  const source = [
    "1. First step:",
    "",
    "   ```text",
    "   https://example.com/a.zip",
    "   ```",
    "",
    "2. Second step.",
    "3. Third:",
    "",
    "   More text.",
    "",
    "After the list.",
  ].join("\n");
  const html = renderMarkdown(source);
  assert.equal((html.match(/<ol>/g) || []).length, 1, "one list, not three");
  assert.ok(html.includes('<li>First step:<pre><code class="language-text">https://example.com/a.zip</code></pre></li>'));
  assert.ok(html.includes("<li>Second step.</li>"));
  assert.ok(html.includes("<li>Third:<p>More text.</p></li>"));
  assert.ok(html.endsWith("<p>After the list.</p>"));
});

test("unordered lists with nested lists", () => {
  const html = renderMarkdown("- **a**: text\n  - inner one\n  - inner two\n- b\n");
  assert.equal(html, "<ul><li><strong>a</strong>: text<ul><li>inner one</li><li>inner two</li></ul></li><li>b</li></ul>");
});

test("HTML comments are dropped and multi-line paragraphs are joined", () => {
  const html = renderMarkdown("<!-- generated -->\n\nline one\nline two\n");
  assert.equal(html, "<p>line one line two</p>");
});
