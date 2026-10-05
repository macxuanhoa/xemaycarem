import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Highlight } from "@/components/search/Highlight";

const html = (text: string, query: string) =>
  renderToStaticMarkup(<Highlight text={text} query={query} />);

describe("Highlight", () => {
  it("wraps a plain case-insensitive match", () => {
    expect(html("Wave RSX", "wave")).toContain(
      '<mark class="search-hit">Wave</mark>',
    );
  });

  it("folds diacritics so an unaccented query marks the accented text", () => {
    // Query "den" must highlight "Đen" while keeping the original spelling.
    expect(html("SH Đen", "den")).toContain(
      '<mark class="search-hit">Đen</mark>',
    );
  });

  it("treats đ/Đ as d for matching", () => {
    expect(html("đỏ Green", "do")).toContain('<mark class="search-hit">đỏ</mark>');
  });

  it("marks every non-overlapping occurrence", () => {
    const out = html("Honda Civic Honda", "honda");
    expect(out.match(/<mark/g)).toHaveLength(2);
  });

  it("returns the text untouched when there is no match or empty query", () => {
    expect(html("Honda", "")).toBe("Honda");
    expect(html("Honda", "yamaha")).toBe("Honda");
  });
});
