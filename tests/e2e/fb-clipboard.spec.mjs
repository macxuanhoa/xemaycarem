import { test, expect } from "@playwright/test";

// Exercise the browser clipboard itself. Supabase and Facebook are outside this
// regression's boundary: a successful image copy must preserve the caption.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

for (const mime of ["image/png", "image/jpeg"]) {
test(`manual sharing preserves text with a ${mime} photo`, async ({ page }) => {
  await page.goto("/login");
  await page.bringToFront();
  const result = await page.evaluate(async mime => {
    const { createBrowserRuntime } = await import("/src/lib/fbShare/service.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#facc15";
    ctx.fillRect(0, 0, 2, 2);
    const caption = "Cà Rem — xe vừa về ☕\nMời bạn ghé xem xe.";
    const runtime = createBrowserRuntime({
      platform: "desktop", webShare: false, webShareFiles: false,
      clipboard: true, secureContext: true, extensionReady: false,
    });
    const outcome = await runtime.writeClipboard(caption, [{
      name: mime === "image/jpeg" ? "xe.jpg" : "xe.png", mime, data: canvas.toDataURL(mime),
    }]);
    const items = await navigator.clipboard.read();
    return {
      caption, outcome, text: await navigator.clipboard.readText(),
      types: items.flatMap((item) => item.types),
    };
  }, mime);
  expect(result.outcome).toEqual({ text: true, images: 1 });
  expect(result.types).toContain("image/png");
  expect(result.types).toContain("text/plain");
  // The native Windows clipboard canonicalizes line endings to CRLF.
  expect(result.text.replace(/\r\n/g, "\n")).toBe(result.caption);
});
}
