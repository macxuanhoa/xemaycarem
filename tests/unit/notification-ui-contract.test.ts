import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTION_TONE } from "@/lib/notifications";

/**
 * Hợp đồng nguồn của giao diện thông báo.
 *
 * Repo này không có jsdom nên vòng đời React và thuộc tính ARIA trên cây thật
 * không render được trong unit test. Các ràng buộc dưới đây chốt thẳng vào mã
 * nguồn — đây chính là những chỗ đã từng hỏng và không được phép hỏng lại:
 *  · P0-1: trang /thong-bao phải luôn có lối vào, kể cả khi hộp thư ít dòng.
 *  · P0-2: tên class surface "page" phải khớp tên styles.css đang định nghĩa.
 *  · P1-a: chuông là dialog — mở thì nhận focus, đóng thì trả về nút chuông,
 *          tin mới phải được trình đọc màn hình nêu bằng một live region.
 *  · P1-b: hai bộ lọc là tab thật (tablist/tab/tabpanel + phím mũi tên).
 *  · P2:   một hàng viết một lần, dùng chung hai surface; chữ chạy vô hạn bỏ.
 *  · P2-b: hàng tiêu đề chuông là MỘT hàng ở mọi khổ — nhãn "Đánh dấu tất cả
 *          đã đọc" co bằng @container chứ không được rơi xuống hàng riêng.
 *  · P2-c: dòng tin phải đọc "thao tác → danh tính xe", mã nội bộ chỉ ghi
 *          thêm cuối dòng (không phải tên xe trước thao tác như bản cũ).
 */

const read = (path: string) => readFileSync(path, "utf8");
/** Bỏ comment để lời giải thích không tự khớp với chính kiểm tra của nó. */
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const css = read("src/styles.css");
const app = read("src/App.tsx");
const bell = strip(read("src/components/NotificationBell.tsx"));
const page = strip(read("src/features/notifications/NotificationsPage.tsx"));
const row = strip(read("src/components/NotificationRow.tsx"));
const bar = strip(read("src/components/AnnouncementBar.tsx"));
const hook = strip(read("src/lib/useNotifications.ts"));

/** Hằng số id (aria-controls/tab id) — là id phần tử, không phải class. */
function idConstants(...sources: string[]): Set<string> {
  const ids = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/const [A-Z0-9_]*ID\s*=\s*["']([^"']+)["']/g)) {
      ids.add(match[1]);
    }
  }
  return ids;
}

/** Mọi tên class `notification*` mà một file source phát ra. */
function emittedClasses(...sources: string[]): string[] {
  const skip = idConstants(...sources);
  const found = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/["'](notifications?-[a-z0-9-]+)["']/g)) {
      // Bỏ đuôi rỗng của template literal `...--${tone}` — kiểm tra riêng.
      if (match[1].endsWith("--")) continue;
      if (skip.has(match[1])) continue;
      found.add(match[1]);
    }
  }
  return [...found].sort();
}

describe("P0-1 — trang thông báo luôn vào được", () => {
  it("/thong-bao là route của mọi vai trò đã đăng nhập, không giấu sau quyền operate/manage", () => {
    const routeAt = app.indexOf('path="thong-bao" element={<NotificationsPage />}');
    expect(routeAt).toBeGreaterThan(-1);
    // Route nằm TRƯỚC khối Protected hẹp hơn đầu tiên trong cây.
    const operateAt = app.indexOf('<Route element={<Protected access="operate" />}>');
    expect(operateAt).toBeGreaterThan(routeAt);
  });

  it("chuông phát ra nút 'Xem tất cả thông báo' và nó chỉ phụ thuộc trạng thái tải", () => {
    expect(bell).toContain("Xem tất cả thông báo");
    expect(bell).toMatch(/className="notification-load-more"/);
    expect(bell).toMatch(/\{\s*!isLoading\s*&&\s*\(\s*<button[\s\S]{0,160}?className="notification-load-more"/);
  });

  it("điều vào bằng đúng đường dẫn router đã đăng ký, không tự chế thêm điều kiện", () => {
    expect(bell).toMatch(/dismiss\(false\);\s*navigate\("\/thong-bao"\)/);
    // `hasMore` chính là thủ phạm cũ: nó tắt lối vào khi cửa hàng chưa đủ 8 tin.
    expect(bell).not.toMatch(/hasMore/);
    expect(hook).not.toMatch(/hasMore/);
    expect(hook).not.toMatch(/\bloadMore\b/);
  });
});

describe("P0-2 + P2 — class khớp CSS, markup chết đã dọn", () => {
  it("mọi class thông báo phát ra từ chuông, trang và hàng dùng chung đều có trong styles.css", () => {
    const missing = emittedClasses(row, bell, page).filter((name) => !css.includes(`.${name}`));
    expect(missing).toEqual([]);
    // Bộ lọc phải quét đủ sâu để không "thành công" vì bỏ sót cả hai surface.
    expect(emittedClasses(row, bell, page).length).toBeGreaterThan(25);
  });

  it("surface 'page' dùng chính tả số nhiều mà styles.css đang ship", () => {
    // Bản cũ phát ra `notification-page-group-label/-dot/-text/-rule` (số ít)
    // nên tiêu đề nhóm của trang hoàn toàn trần.
    expect(css).toContain(".notifications-page-group-label");
    expect(css).toContain(".notifications-page-group-dot");
    expect(css).toContain(".notifications-page-group-text");
    expect(css).toContain(".notifications-page-group-rule");
    expect(row).toContain("notifications-page-group-label");
  });

  it("mọi tone bảng ACTION_TONE đều có luật màu cho surface page", () => {
    const tones = [...new Set(Object.values(ACTION_TONE))];
    expect(css).toContain(".notification-page-icon");
    for (const tone of tones) {
      // "neutral" là mặc định của nền class, không cần phần tử bổ sung.
      if (tone === "neutral") continue;
      expect(css, `thiếu luật .notification-page-icon--${tone}`).toContain(
        `.notification-page-icon--${tone}`,
      );
    }
  });

  it("không còn dấu vết markup/kiểu của bảng thông báo cũ", () => {
    for (const source of [css, bell, page, row]) expect(source).not.toMatch(/notification-sheet/);
  });
});

describe("P1-a — chuông là dialog có quản lý focus và live region", () => {
  it("panel mang ngữ nghĩa dialog, tự lấy focus khi mở và trả về nút chuông khi đóng", () => {
    expect(bell).toContain('role="dialog"');
    expect(bell).toContain('aria-label="Thông báo"');
    expect(bell).toContain("ref={panelRef}");
    expect(bell).toContain("tabIndex={-1}");
    expect(bell).toContain("panelRef.current?.focus()");
    expect(bell).toContain("buttonRef.current?.focus()");
    expect(bell).toContain("aria-expanded={open}");
  });

  it("đóng vì bấm ra ngoài/Esc thì giành lại focus, điều hướng đi thì nhường focus cho trang đích", () => {
    const dismissCalls = [...bell.matchAll(/dismiss\((true|false)\)/g)].map((m) => m[1]);
    expect(dismissCalls).toContain("true");
    expect(dismissCalls).toContain("false");
    expect(bell).toMatch(/event\.key === "Escape"[\s\S]{0,80}?dismiss\(true\)/);
    // Chuỗi điều hướng phải là dismiss(false): kéo focus về chuông sẽ bỏ rơi
    // người dùng bàn phím ở chính control họ vừa rời khỏi.
    expect(bell).toMatch(/if \(item\.deep_link\) \{\s*dismiss\(false\);\s*navigate\(item\.deep_link\)/);
  });

  it("tin mới được công bố bằng vùng status nằm ngoài portal", () => {
    expect(bell).toContain('role="status"');
    expect(bell).toContain('aria-live="polite"');
    expect(bell.indexOf('role="status"')).toBeLessThan(bell.indexOf("createPortal("));
    expect(bell).toMatch(/setAnnouncement\(\s*`\$\{arrived\} thông báo mới/);
  });
});

describe("P1-b — bộ lọc là tabs đúng ngữ nghĩa và điều hướng được bằng phím", () => {
  it("có tablist, hai tab, một tabpanel nối bằng id/aria-controls/aria-labelledby", () => {
    expect(page).toContain('role="tablist"');
    expect([...page.matchAll(/role="tab"/g)]).toHaveLength(2);
    expect(page).toContain('role="tabpanel"');
    expect(page).toContain("id={PANEL_ID}");
    // Hai id bộ lọc phải thật sự được gắn, nếu không chúng chỉ là chuỗi chết.
    expect(page).toContain("id={TAB_ALL_ID}");
    expect(page).toContain("id={TAB_UNREAD_ID}");
    expect([...page.matchAll(/aria-controls=\{PANEL_ID\}/g)]).toHaveLength(2);
    expect(page).toContain("aria-labelledby={unreadOnly ? TAB_UNREAD_ID : TAB_ALL_ID}");
  });

  it("roving tabindex và aria-selected lật theo bộ lọc đang bật", () => {
    expect(page).toContain("aria-selected={!unreadOnly}");
    expect(page).toContain("aria-selected={unreadOnly}");
    expect(page).toContain("tabIndex={unreadOnly ? -1 : 0}");
    expect(page).toContain("tabIndex={unreadOnly ? 0 : -1}");
    expect([...page.matchAll(/onKeyDown=\{onTabKeyDown\}/g)]).toHaveLength(2);
  });

  it("mũi tên và Home/End chuyển tab đồng thời chuyển focus thật", () => {
    for (const key of ['"ArrowLeft"', '"ArrowRight"', '"Home"', '"End"']) {
      expect(page).toContain(`case ${key}:`);
    }
    expect(page).toContain("event.preventDefault()");
    expect(page).toMatch(
      /\(nextUnreadOnly \? unreadTabRef : allTabRef\)\.current\?\.focus\(\)/,
    );
  });
});

describe("P2 — một hàng viết một lần cho cả hai surface", () => {
  it("chuông và trang cùng nạp hàng + tiêu đề nhóm dùng chung", () => {
    for (const source of [bell, page]) {
      expect(source).toMatch(/NotificationGroupHeading,[\s\S]{0,60}?NotificationRow|NotificationRow,[\s\S]{0,60}?NotificationGroupHeading/);
      expect(source).toContain('from "@/components/NotificationRow"');
      expect(source).toMatch(/<NotificationRow\b/);
      expect(source).toMatch(/<NotificationGroupHeading\b/);
    }
    expect(bell).toContain('surface="sheet"');
    expect(page).toContain('surface="page"');
  });

  it("không surface nào tự viết lại markup của hàng nữa", () => {
    for (const name of emittedClasses(row)) {
      if (name.startsWith("notification-row")) {
        expect(page, `trang tự tái bản ${name}`).not.toContain(`"${name}"`);
        expect(bell, `chuông tự tái bản ${name}`).not.toContain(`"${name}"`);
      }
      if (name.startsWith("notification-page") || name.startsWith("notifications-page")) {
        expect(bell).not.toContain(`"${name}"`);
      }
    }
  });

  it("tone gắn trên hàng để CSS phân biệt trạng thái cần người xử lý", () => {
    expect(row).toContain("data-tone={tone}");
    expect(row).toContain('ACTION_ICON[item.action] ?? NOTIFICATION_FALLBACK_ICON');
  });
});

describe("P2-b — hàng tiêu đề chuông luôn là MỘT hàng", () => {
  // Bỏ comment: lời giải thích trong CSS kể lại chính lỗi cũ ("trước đây
  // flex-wrap: wrap") nên kiểm tra phải soi phần luật, không soi cả file.
  const style = strip(css);
  const headerRule = () =>
    style.match(/\.notification-panel-header\s*\{[^}]*\}/)?.[0] ?? "";

  it("tiêu đề + số chưa đọc + cụm hành động không còn được xuống hàng", () => {
    const rule = headerRule();
    expect(rule).toContain("flex-wrap: nowrap");
    expect(rule).not.toContain("flex-wrap: wrap");
    // row-gap chỉ tồn tại để nới hàng thứ hai — phải biến mất cùng wrap.
    expect(rule).not.toMatch(/row-gap/);
    // Chính hàng tiêu đề là container, nên ngưỡng co nhãn đo theo số chỗ THẬT
    // còn lại của hàng (panel 420px từng bị tính nhầm thành 418 vì viền).
    expect(rule).toContain("container-type: inline-size");
    // Khối hành động không được co, tiêu đề mới là phần nhường chỗ.
    expect(rule).toMatch(/justify-content: space-between/);
  });

  it("nhãn nút đánh dấu tách thành span riêng, cất bằng @container chứ không gãy hàng", () => {
    // aria-label mang cả cụm đầy đủ → tên trợ năng không đổi khi CSS cất chữ.
    expect(bell).toMatch(
      /className="notification-mark-all"[\s\S]{0,240}?aria-label="Đánh dấu tất cả đã đọc"/,
    );
    expect(bell).toContain("Đánh dấu tất cả đã đọc");
    expect(bell).toMatch(/className="notification-mark-all-label"/);
    const tier = style.match(/@container[^{]*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(tier).toMatch(/@container \(max-width: \d+px\)/);
    expect(tier).toMatch(/\.notification-mark-all-label\s*\{[^}]*display: none/);
    // Mất chữ thì icon phải còn ô vuông đủ to bấm bằng ngón tay.
    expect(tier).toMatch(/\.notification-mark-all\s*\{[^}]*min-width: 40px/);
    expect(tier).toMatch(/\.notification-mark-all\s*\{[^}]*min-height: 40px/);
  });
});

describe("P2-c — dòng tiêu đề đọc là THAO TÁC rồi mới đến xe", () => {
  it("hành động đứng đầu, danh tính xe (tên loại + biển số) gom một cụm ngay sau đó", () => {
    expect(row).toMatch(
      /<span className=\{cls\.title\}>\s*\{parts\.action\}\s*\{[\s\S]{0,160}?className="notification-vehicle"/,
    );
    // Chip tên loại xe từng đứng TRƯỚC cả câu → "Honda Wave Alpha Thu vào xe".
    expect(row).not.toMatch(/<span className=\{cls\.title\}>\s*\{typeName/);
    // Biển số và tên loại xe phải nằm TRONG cùng một viên danh tính.
    expect(row).toMatch(
      /className="notification-vehicle"[\s\S]{0,400}?className="notification-vehicle-type"[\s\S]{0,400}?className=\{identityClass\}/,
    );
    expect(row).toContain('"notification-vehicle-plate"');
    expect(row).toContain('"notification-vehicle-phrase"');
    // Đuôi số khung KHÔNG được quay lại tiêu đề: body đã nêu lại nguyên nhãn,
    // nhét nó vào tiêu đề chỉ khiến dòng tin gãy đôi trong panel 460px.
    expect(row).not.toMatch(/parts\.detail/);
  });

  it("mã nội bộ là phần ghi thêm cuối dòng tiêu đề, không còn dính vào body", () => {
    const titleAt = row.indexOf("cls.title");
    const codeAt = row.indexOf("notification-internal-code");
    const bodyAt = row.indexOf("{item.body &&");
    expect(titleAt).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(titleAt);
    expect(codeAt).toBeLessThan(bodyAt);
    // Không được phát ra class mã nội bộ bên trong khối body.
    expect(row.slice(bodyAt)).not.toContain("notification-internal-code");
  });
});

describe("P2 — không còn dải chữ chạy vô hạn", () => {
  it("thành phần và stylesheet không còn marquee", () => {
    expect(bar).not.toMatch(/marquee/i);
    expect(css).not.toMatch(/marquee/i);
    expect(css).not.toMatch(/@keyframes\s+\w*announce/i);
  });

  it("thông báo chạy ngang trở thành vùng cuộn đọc được, có focus và có nhãn", () => {
    expect(bar).toContain('display_mode === "SCROLLING"');
    expect(bar).toContain('role="region"');
    expect(bar).toContain("tabIndex={0}");
    expect(bar).toContain('className="announcement-scroll"');
    expect(bar).toMatch(/aria-label="[^"]*kéo ngang[^"]*"/);
    const scrollRule = css.match(/\.announcement-scroll\s*\{[^}]*\}/)?.[0] ?? "";
    expect(scrollRule).toContain("overflow-x: auto");
    expect(scrollRule).not.toMatch(/animation:/);
    expect(css).toContain(".announcement-scroll:focus-visible");
  });

  it("hai đầu hàng được bốc mờ để báo còn chữ ngoài khung nhìn", () => {
    expect(css).toMatch(/\.announcement-content\[data-mode="SCROLLING"\][\s\S]{0,240}?mask-image/);
  });
});
