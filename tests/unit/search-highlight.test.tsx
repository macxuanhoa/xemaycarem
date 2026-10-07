import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Highlight } from "@/components/search/Highlight";

const html = (text?: string | null, query?: string | null) =>
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

  it("highlights multiple words/tokens across the text", () => {
    const out = html("Honda Wave Alpha 2020", "honda alpha");
    expect(out).toContain('<mark class="search-hit">Honda</mark>');
    expect(out).toContain('<mark class="search-hit">Alpha</mark>');
    expect(out).not.toContain('<mark class="search-hit">Wave</mark>');
  });

  it("merges adjacent/overlapping tokens into a single clean mark", () => {
    const out = html("Honda Wave Alpha", "wave alpha");
    expect(out).toContain('<mark class="search-hit">Wave Alpha</mark>');
  });

  it("handles special characters like parentheses and dashes safely", () => {
    const out = html("Air Blade (125cc) - Đỏ", "blade (125cc)");
    expect(out).toContain('<mark class="search-hit">Blade (125cc)</mark>');
  });

  it("handles null or undefined text and queries safely", () => {
    expect(html(null, "wave")).toBe("");
    expect(html(undefined, "wave")).toBe("");
    expect(html("Wave", null)).toBe("Wave");
    expect(html("Wave", undefined)).toBe("Wave");
  });
});
