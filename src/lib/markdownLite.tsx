import { cloneElement, isValidElement, type ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Minimal, deliberate Markdown renderer for AI answers and store documents.
 *
 * Content is treated as data: everything is rendered through React nodes, never
 * `dangerouslySetInnerHTML`, and the only links produced are internal routes
 (`/…` or `#…`). A citation marker such as `[d3]` becomes whatever node the
 caller supplies, which is how every claim stays clickable.
 */

// Bold, inline code, internal links and citation markers such as `[c1]`.
const INLINE_TOKEN =
  /\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:\/|#)[^)\s]*\)|\[[a-z]{1,3}\d{1,3}\]/g;

function renderInline(
  value: string,
  citations: Record<string, ReactNode>,
  uid: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(value.slice(cursor, index));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`${uid}-b${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={`${uid}-c${index}`}>{token.slice(1, -1)}</code>);
    } else if (token.endsWith("]")) {
      const id = token.slice(1, -1);
      const citationNode = citations[id];
      if (citationNode !== undefined) {
        if (isValidElement(citationNode)) {
          nodes.push(cloneElement(citationNode, { key: `${uid}-c-${index}` }));
        } else {
          nodes.push(<span key={`${uid}-c-${index}`}>{citationNode}</span>);
        }
      } else {
        nodes.push(<span key={`${uid}-x${index}`}>{id}</span>);
      }
    } else {
      const link = /^\[([^\]]+)\]\(((?:\/|#)[^)\s]*)\)$/.exec(token);
      if (link)
        nodes.push(
          <Link key={`${uid}-l${index}`} to={link[2]}>
            {link[1]}
          </Link>,
        );
    }
    cursor = index + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

const splitRow = (line: string) =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());

export function MarkdownLite({
  text,
  citations = {},
  className,
}: {
  text: string;
  citations?: Record<string, ReactNode>;
  className?: string;
}) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let listKind: "ul" | "ol" | null = null;
  const flushList = (key: string) => {
    if (!listKind || !list.length) return;
    blocks.push(
      listKind === "ol" ? (
        <ol key={key} className="markdown-list">
          {list}
        </ol>
      ) : (
        <ul key={key} className="markdown-list">
          {list}
        </ul>
      ),
    );
    list = [];
    listKind = null;
  };

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.trim();

    // Fenced code is copied verbatim until the closing fence.
    if (line.startsWith("```")) {
      flushList(`l${index}`);
      const body: string[] = [];
      while (index + 1 < lines.length && !lines[index + 1].trim().startsWith("```")) {
        body.push(lines[++index]);
      }
      index++;
      blocks.push(
        <pre key={`p${index}`} className="markdown-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (!line) {
      flushList(`l${index}`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushList(`l${index}`);
      blocks.push(<hr key={`h${index}`} className="markdown-rule" />);
      continue;
    }

    const heading = /^(#{1,5})\s+(.*)$/.exec(line);
    if (heading) {
      flushList(`l${index}`);
      const depth = Math.min(heading[1].length + 1, 5);
      const Tag = `h${depth}` as "h2" | "h3" | "h4" | "h5";
      blocks.push(
        <Tag key={`d${index}`} className="markdown-heading">
          {renderInline(heading[2], citations, `d${index}`)}
        </Tag>,
      );
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      if (listKind && listKind !== (numbered ? "ol" : "ul")) flushList(`l${index}`);
      listKind = numbered ? "ol" : "ul";
      list.push(
        <li key={`i${index}`}>
          {renderInline(item[1], citations, `i${index}`)}
        </li>,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushList(`l${index}`);
      blocks.push(
        <blockquote key={`q${index}`} className="markdown-quote">
          {renderInline(quote[1], citations, `q${index}`)}
        </blockquote>,
      );
      continue;
    }

    // A table is a header row, a `---` separator and then data rows.
    if (line.includes("|") && lines[index + 1]?.includes("-")) {
      flushList(`l${index}`);
      const head = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(splitRow(lines[index]));
        index++;
      }
      index--;
      blocks.push(
        <div key={`t${index}`} className="markdown-table-wrap">
          <table className="markdown-table">
            <thead>
              <tr>
                {head.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInline(cell, citations, `th${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {head.map((_, cellIndex) => (
                    <td key={cellIndex}>
                      {renderInline(row[cellIndex] ?? "", citations, `td${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    flushList(`l${index}`);
    blocks.push(
      <p key={`w${index}`}>{renderInline(line, citations, `w${index}`)}</p>,
    );
  }
  flushList("l-end");

  return <div className={`markdown${className ? ` ${className}` : ""}`}>{blocks}</div>;
}
