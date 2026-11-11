/**
 * A small Markdown renderer for the documentation site.
 *
 * It covers what the documents in docs/ use: headings with GitHub-style
 * anchors, paragraphs, fenced code, lists with nested blocks, GFM tables,
 * block quotes with [!NOTE]-style callouts, and inline code, bold, and links.
 * It has no dependencies, so the site builds wherever Node.js runs.
 */

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/**
 * @param {string} text inline Markdown
 * @param {(href: string) => string} resolveLink
 */
export function renderInline(text, resolveLink = (href) => href) {
  const codes = [];
  // Code spans first, so nothing inside them is treated as markup.
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${resolveLink(src)}" alt="${alt}" />`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const target = resolveLink(href.replace(/&amp;/g, "&"));
    const external = /^https?:/.test(target);
    return `<a href="${escapeHtml(target)}"${external ? ' rel="noopener"' : ""}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

function splitTableRow(line) {
  const cells = [];
  let current = "";
  let inCode = false;
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i];
    if (character === "`") inCode = !inCode;
    if (character === "\\" && body[i + 1] === "|") { current += "|"; i += 1; continue; }
    if (character === "|" && !inCode) { cells.push(current.trim()); current = ""; continue; }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

const CALLOUTS = { NOTE: "note", TIP: "tip", IMPORTANT: "important", WARNING: "warning", CAUTION: "warning" };

/**
 * @param {string} source Markdown
 * @param {{ resolveLink?: (href: string) => string, headings?: object[] }} [options]
 * @returns {string} HTML
 */
export function renderMarkdown(source, options = {}) {
  const resolveLink = options.resolveLink || ((href) => href);
  const headings = options.headings || [];
  const usedSlugs = new Map();
  const inline = (text) => renderInline(text, resolveLink);

  function renderBlocks(lines) {
    const html = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === "") { index += 1; continue; }
      if (/^<!--/.test(line.trim())) {
        while (index < lines.length && !lines[index].includes("-->")) index += 1;
        index += 1;
        continue;
      }

      const fence = /^(\s*)```(\S*)\s*$/.exec(line);
      if (fence) {
        const indent = fence[1].length;
        const body = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          body.push(lines[index].slice(Math.min(indent, lines[index].search(/\S|$/))));
          index += 1;
        }
        index += 1;
        const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
        html.push(`<pre><code${language}>${escapeHtml(body.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        const text = heading[2].trim();
        let slug = slugify(text.replace(/`/g, ""));
        const seen = usedSlugs.get(slug) || 0;
        usedSlugs.set(slug, seen + 1);
        if (seen > 0) slug = `${slug}-${seen}`;
        headings.push({ level, text: text.replace(/`/g, ""), slug });
        html.push(`<h${level} id="${escapeHtml(slug)}"><a class="anchor" href="#${escapeHtml(slug)}">${inline(text)}</a></h${level}>`);
        index += 1;
        continue;
      }

      if (/^\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
        const header = splitTableRow(line);
        index += 2;
        const rows = [];
        while (index < lines.length && /^\|.*\|\s*$/.test(lines[index])) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        html.push(
          `<div class="table-wrap"><table><thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`
          + `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
        );
        continue;
      }

      if (/^>\s?/.test(line)) {
        const body = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          body.push(lines[index].replace(/^>\s?/, ""));
          index += 1;
        }
        const callout = /^\[!([A-Z]+)\]\s*$/.exec(body[0] || "");
        if (callout && CALLOUTS[callout[1]]) {
          html.push(`<div class="callout callout-${CALLOUTS[callout[1]]}">${renderBlocks(body.slice(1))}</div>`);
        } else {
          html.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
        }
        continue;
      }

      const listMarker = /^(\s*)([-*]|\d+\.)\s+/.exec(line);
      if (listMarker && listMarker[1].length === 0) {
        const ordered = /\d/.test(listMarker[2]);
        const items = [];
        while (index < lines.length) {
          const marker = /^([-*]|\d+\.)\s+(.*)$/.exec(lines[index]);
          if (!marker || /\d/.test(marker[1]) !== ordered) break;
          const width = lines[index].length - marker[2].length;
          const item = [marker[2]];
          index += 1;
          // Indented and blank lines continue the item; a blank line followed
          // by an unindented line ends it.
          while (index < lines.length) {
            const next = lines[index];
            if (next.trim() === "") {
              const after = lines[index + 1];
              if (after === undefined || !/^\s{2,}\S/.test(after)) break;
              item.push("");
              index += 1;
              continue;
            }
            if (!/^\s{2,}/.test(next)) break;
            item.push(next.slice(Math.min(width, next.search(/\S/))));
            index += 1;
          }
          items.push(item);
          while (index < lines.length && lines[index].trim() === "" && /^([-*]|\d+\.)\s+/.test(lines[index + 1] || "")) index += 1;
        }
        const tag = ordered ? "ol" : "ul";
        const rendered = items.map((item) => {
          const simple = item.length === 1 || item.slice(1).every((entry) => entry.trim() !== "" && !/^(\s*[-*]\s|\s*\d+\.\s|```|\|)/.test(entry));
          if (simple) return `<li>${inline(item.join(" "))}</li>`;
          return `<li>${inline(item[0])}${renderBlocks(item.slice(1))}</li>`;
        });
        html.push(`<${tag}>${rendered.join("")}</${tag}>`);
        continue;
      }

      const paragraph = [];
      while (index < lines.length && lines[index].trim() !== ""
        && !/^(#{1,6}\s|>\s?|\s*```|\|.*\|\s*$|[-*]\s|\d+\.\s)/.test(lines[index])) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      if (paragraph.length === 0) { paragraph.push(lines[index].trim()); index += 1; }
      html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    }
    return html.join("\n");
  }

  return renderBlocks(source.replace(/\r\n/g, "\n").split("\n"));
}
