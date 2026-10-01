import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { MarkdownLite } from "@/lib/markdownLite";
import { CitationChip, CitationList } from "@/features/copilot/CitationLinks";
import type { CopilotCitation } from "@/types";

const citation: CopilotCitation = {
  id: "v1",
  type: "vehicle",
  label: "Honda Wave",
  detail: "59-B1 123",
  route: `/vehicles/11111111-1111-4111-8111-111111111111`,
};

const render = (text: string, citations: Record<string, ReactNode> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <MarkdownLite text={text} citations={citations} />
    </MemoryRouter>,
  );

describe("copilot markdown renderer keeps answers readable and safe", () => {
  it("renders the small markdown subset the copilot and docs use", () => {
    const html = render(
      ["## Tồn kho", "- **7 xe** đang chờ", "1. Mở kho", "> Lưu ý quan trọng", "```bash", "npm run lint", "```"].join("\n"),
    );
    expect(html).toContain("<h3");
    expect(html).toContain("<strong>7 xe</strong>");
    expect(html).toContain("npm run lint");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<ol");
  });

  it("renders pipe tables so documents stay readable", () => {
    const html = render("|Role|Reads debt|\n|--|--|\n|STAFF|Có|");
    expect(html).toContain("<table");
    expect(html).toContain("<th>Role</th>");
    expect(html).toContain("<td>STAFF</td>");
  });

  it("turns citation markers into the caller-provided evidence nodes", () => {
    const html = render("Tồn 7 xe [v1].", { v1: <CitationChip citation={citation} /> });
    expect(html).toContain("citation-chip");
    expect(html).toContain("v1");
    // An unknown marker must degrade to plain text, never a broken link.
    expect(render("Tồn 7 xe [zz9].")).toContain("zz9");
    expect(render("Tồn 7 xe [zz9].")).not.toContain("<a");
  });

  it("only links inside the app and never trusts raw HTML", () => {
    expect(render("Xem [sổ nợ](/receivables) nhé")).toContain('href="/receivables"');
    expect(render("Ghé [web](https://evil.test) đi")).not.toContain("href=\"https");
    expect(render("<script>alert(1)</script>")).not.toContain("<script>alert");
  });
});

describe("copilot evidence list", () => {
  it("links every citation to the screen that proves it", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CitationList citations={[citation]} />
      </MemoryRouter>,
    );
    expect(html).toContain("Mở bằng chứng v1");
    expect(html).toContain("Honda Wave");
    expect(html).toContain("59-B1 123");
    expect(html).toContain("/vehicles/11111111-1111-4111-8111-111111111111");
  });
});
