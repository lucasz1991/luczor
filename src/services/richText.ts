// src/services/richText.ts
//
// Safe Markdown -> HTML renderer for assistant chat output.
//
// SECURITY MODEL (important):
//   The input is HTML-escaped FIRST, then only this module emits tags. That
//   means model output can never inject markup: any '<' in the result was
//   written by the code below, never by the model. No sanitizer is required
//   and no third-party dependency is pulled in (offline / no-CDN posture).
//
//   Links are emitted WITHOUT an href (data-href instead) so the WebView can
//   never be navigated away from the app shell. The chat view intercepts the
//   click and hands the URL to the `open_url` Tauri command, which already
//   enforces http(s)-only.
//
// The renderer is streaming-tolerant: a code fence or table that is still
// mid-stream renders as far as it got instead of showing raw markup.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape every HTML-significant character. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

// Private-use markers used to park inline-code spans while other inline rules
// run. Stripped from the input up front so they can never arrive from outside.
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";

function stripMarkers(value: string): string {
  return value.replace(/[\uE000\uE001]/g, "");
}

/* =================================================================
 * Inline level
 * ================================================================= */

/** Build a click-safe link, or null when the URL is not allowed. */
function renderLink(escapedText: string, escapedUrl: string): string | null {
  // The URL arrives already escaped; only '&' needs undoing to validate it.
  const url = escapedUrl.replace(/&amp;/g, "&").trim();
  if (!/^(?:https?:\/\/|mailto:)[^\s]+$/i.test(url)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  const safe = escapeHtml(url);
  return `<a class="rt-link" data-href="${safe}" title="${safe}" role="link" tabindex="0">${escapedText}</a>`;
}

/**
 * Render inline markdown (code, links, emphasis) from RAW text.
 * Escaping happens here, so callers must pass unescaped source.
 */
export function renderInline(raw: string): string {
  const codeSpans: string[] = [];
  let text = escapeHtml(raw);

  // 1. Inline code first — its content must stay literal.
  text = text.replace(/(`+)([^`]+?)\1/g, (_match, _ticks, code: string) => {
    codeSpans.push(`<code class="rt-code-inline">${code}</code>`);
    return `${MARK_OPEN}${codeSpans.length - 1}${MARK_CLOSE}`;
  });

  // 2. Explicit links [text](url).
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    return renderLink(label, url) ?? match;
  });

  // 3. Bare URLs. The prefix group keeps this from matching inside the
  //    attributes emitted in step 2 (those are preceded by '"').
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (match, prefix: string, url: string) => {
    const anchor = renderLink(url, url);
    return anchor ? `${prefix}${anchor}` : match;
  });

  // 4. Emphasis.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

  // 5. Restore inline code.
  return text.replace(
    new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g"),
    (_match, index: string) => codeSpans[Number(index)] ?? ""
  );
}

/* =================================================================
 * Block level
 * ================================================================= */

const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RE_HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_LIST = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

type ListItem = { indent: number; ordered: boolean; start: number; lines: string[] };

/** Render a full markdown document to HTML. */
export function renderRichText(input: string): string {
  const source = stripMarkers(String(input ?? "")).replace(/\r\n?/g, "\n");
  if (!source.trim()) return "";
  return renderBlocks(source.split("\n"));
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (!line.trim()) {
      i++;
      continue;
    }

    // --- fenced code ------------------------------------------------
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const lang = (fence[2] ?? "").trim();
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const candidate = lines[i] ?? "";
        const closing = RE_FENCE.exec(candidate);
        if (closing && (closing[1] ?? "").startsWith(marker[0] ?? "`")) {
          i++;
          break;
        }
        body.push(candidate);
        i++;
      }
      const label = lang ? `<span class="rt-code__lang">${escapeHtml(lang)}</span>` : "";
      out.push(
        `<div class="rt-code"><pre class="rt-code__pre"><code>${escapeHtml(body.join("\n"))}</code></pre>${label}</div>`
      );
      continue;
    }

    // --- heading ----------------------------------------------------
    const heading = RE_HEADING.exec(line);
    if (heading) {
      const depth = (heading[1] ?? "#").length;
      // Chat bubbles must not carry document-sized headings.
      const tag = depth <= 1 ? "h3" : depth === 2 ? "h4" : "h5";
      out.push(`<${tag} class="rt-h rt-h--${depth}">${renderInline(heading[2] ?? "")}</${tag}>`);
      i++;
      continue;
    }

    // --- horizontal rule -------------------------------------------
    if (RE_HR.test(line)) {
      out.push('<hr class="rt-hr" />');
      i++;
      continue;
    }

    // --- blockquote -------------------------------------------------
    if (RE_QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const match = RE_QUOTE.exec(lines[i] ?? "");
        if (!match) break;
        quoted.push(match[1] ?? "");
        i++;
      }
      out.push(`<blockquote class="rt-quote">${renderBlocks(quoted)}</blockquote>`);
      continue;
    }

    // --- table ------------------------------------------------------
    if (line.includes("|") && RE_TABLE_SEP.test(lines[i + 1] ?? "")) {
      const consumed = renderTable(lines, i);
      if (consumed) {
        out.push(consumed.html);
        i = consumed.next;
        continue;
      }
    }

    // --- list -------------------------------------------------------
    if (RE_LIST.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const match = RE_LIST.exec(current);
        if (match) {
          items.push({
            indent: (match[1] ?? "").length,
            ordered: match[3] != null,
            start: match[3] != null ? Number(match[3]) : 1,
            lines: [match[4] ?? ""],
          });
          i++;
          continue;
        }
        // Indented continuation of the previous item.
        const last = items[items.length - 1];
        if (last && current.trim() && /^\s{2,}/.test(current)) {
          last.lines.push(current.trim());
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(items, 0, items[0]?.indent ?? 0).html);
      continue;
    }

    // --- paragraph --------------------------------------------------
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (
        !current.trim() ||
        RE_FENCE.test(current) ||
        RE_HEADING.test(current) ||
        RE_HR.test(current) ||
        RE_QUOTE.test(current) ||
        RE_LIST.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      i++;
    }
    if (paragraph.length) {
      out.push(`<p class="rt-p">${paragraph.map((l) => renderInline(l)).join("<br />")}</p>`);
    }
  }

  return out.join("");
}

/** Recursively build (possibly nested) list markup from flat items. */
function renderList(items: ListItem[], from: number, indent: number): { html: string; next: number } {
  const first = items[from];
  if (!first) return { html: "", next: from };

  const ordered = first.ordered;
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && first.start !== 1 ? ` start="${first.start}"` : "";
  const parts: string[] = [];
  let i = from;

  while (i < items.length) {
    const item = items[i];
    if (!item || item.indent < indent) break;

    if (item.indent > indent) {
      const nested = renderList(items, i, item.indent);
      const last = parts.length - 1;
      const previous = parts[last];
      if (previous !== undefined) {
        // The sublist belongs INSIDE the item that opened it, otherwise the
        // markup is invalid and the browser flattens the indentation.
        parts[last] = previous.replace(/<\/li>$/, `${nested.html}</li>`);
      } else {
        parts.push(`<li class="rt-li">${nested.html}</li>`);
      }
      i = nested.next;
      continue;
    }

    // A sibling that switches marker type starts a new list.
    if (item.ordered !== ordered) break;

    const body = renderBlocks(item.lines).replace(/^<p class="rt-p">([\s\S]*)<\/p>$/, "$1");
    parts.push(`<li class="rt-li">${body}</li>`);
    i++;
  }

  return { html: `<${tag} class="rt-list"${startAttr}>${parts.join("")}</${tag}>`, next: i };
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderTable(lines: string[], start: number): { html: string; next: number } | null {
  const header = splitRow(lines[start] ?? "");
  if (!header.length) return null;

  const aligns = splitRow(lines[start + 1] ?? "").map((spec) => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });

  const align = (index: number): string => {
    const value = aligns[index];
    return value ? ` style="text-align:${value}"` : "";
  };

  const head = header.map((cell, c) => `<th${align(c)}>${renderInline(cell)}</th>`).join("");
  const body: string[] = [];
  let i = start + 2;

  while (i < lines.length) {
    const row = lines[i] ?? "";
    if (!row.trim() || !row.includes("|")) break;
    const cells = splitRow(row);
    body.push(
      `<tr>${header
        .map((_h, c) => `<td${align(c)}>${renderInline(cells[c] ?? "")}</td>`)
        .join("")}</tr>`
    );
    i++;
  }

  return {
    html:
      `<div class="rt-table-wrap"><table class="rt-table">` +
      `<thead><tr>${head}</tr></thead>` +
      `<tbody>${body.join("")}</tbody></table></div>`,
    next: i,
  };
}
