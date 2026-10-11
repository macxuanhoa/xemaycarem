// Content script của "Cà Rem · Cầu đăng Facebook" — chạy TRONG trang Facebook.
//
// Đây là phần nhạy cảm nhất nên tự đặt ba luật cứng:
//  1) KHÔNG BAO GIỜ bấm nút Đăng. tiện ích chỉ ĐƯA nội dung vào ô soạn thảo.
//  2) KHÔNG đọc cookie / localStorage / GraphQL token của Facebook. Không cần,
//     và nếu đọc thì người dùng có quyền nghi ngờ mục đích.
//  3) Không tin một selector cố định. Facebook đổi cấu trúc DOM và tên lớp liên
//     tục, nên mọi thứ đều đi theo DANH SÁCH dấu hiệu (role, aria-label, placeholder
//     đã bản địa hoá, kết cấu cây) rồi MỚI tới kiểm chứng bằng cách đọc lại nội
//     dung. Không có bằng chứng đọc được => báo thất bại, không báo "đã điền".

(function caremFbShareContent() {
  "use strict";

  if (window.__caremFbShareInstalled) {
    // Inject lặp (background fallback sau khi manifest đã inject) → chỉ gắn listener một lần.
    return;
  }
  window.__caremFbShareInstalled = true;

  const CHANNEL = "carem-fb-share";
  const PROTOCOL = 1;
  const CAPTION_FILL_THRESHOLD = 0.85;
  const POLL_MS = 300;

  // Chuỗi bản địa hoá cho ô soạn thảo. Facebook đổi câu chữ, ta mở rộng danh sách.
  const COMPOSER_HINTS = [
    "bạn đang nghĩ gì",
    "what's on your mind",
    "what is on your mind",
    "create a post",
    "create post",
    "viết bài",
    "sáng tạo bài đăng",
    "bài viết của bạn",
    "write something",
    "share something",
    "post something",
  ];

  // Nhãn của NÚT MỞ ô soạn thảo (khác với nút gửi). Đủ dài để không nhầm với "Đăng".
  const OPENER_LABELS = [
    "bạn đang nghĩ gì",
    "what's on your mind",
    "create a post",
    "create post",
    "viết bài",
    "sáng tạo bài đăng",
    "đăng bài",
    "thảo luận",
    "write post",
  ];

  // Bộ chặn: nhãn khớp CHÍNH XÁC danh sách này là NÚT GỬI — tuyệt đối không click.
  // So khớp toàn bộ (không khớp một phần) vì "Đăng bài" là nhãn MỞ composer, còn
  // nút gửi chỉ có một chữ "Đăng".
  const SUBMIT_LABELS = ["đăng", "post", "gửi", "send", "submit", "chia sẻ ngay", "share now"];

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  /** Nhãn đơn lẻ của một phần tử: aria-label trước, rồi tới chữ hiển thị. */
  function labelOf(element) {
    if (!element) return "";
    return normalize(element.getAttribute("aria-label") || "") || normalize(element.textContent || "");
  }

  /** Chuỗi tìm kiếm mở rộng: dùng cho khớp MỘT PHẦN (placeholder, mô tả ngắn). */
  function textOf(element) {
    if (!element) return "";
    return labelOf(element) + " " + normalize(element.getAttribute("data-placeholder") || "") + " " + normalize(element.textContent || "");
  }

  function isSubmitLabel(element) {
    // So khớp TOÀN BỘ nhãn: "đăng bài" mở composer, "đăng" mới là nút gửi.
    const label = labelOf(element);
    return !!label && SUBMIT_LABELS.indexOf(label) >= 0;
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  // ---------------------------------------------------------------------------
  // Kiểm chứng caption: cùng thuật toán với src/lib/fbShare/protocol.ts. Facebook
  // có thể tự đổi whitespace/emoji-render, nên so theo tỷ lệ khớp, không so từng ký tự.
  // ---------------------------------------------------------------------------
  function captionFilledRatio(expected, actual) {
    const want = normalize(expected);
    const got = normalize(actual);
    if (!want) return 0;
    if (got === want) return 1;
    if (got && want.indexOf(got) === 0) return got.length / want.length;
    let index = 0;
    let matched = 0;
    for (const char of got) {
      const found = want.indexOf(char, index);
      if (found < 0) continue;
      index = found + 1;
      matched += 1;
    }
    return matched / want.length;
  }

  function readCaption(element) {
    if (!element) return "";
    if (typeof element.innerText === "string") return element.innerText;
    return element.textContent || "";
  }

  function isLoginScreen() {
    if (/\/(login|recover|checkpoint)\b/i.test(location.pathname)) return true;
    const emailField = document.querySelector('input[type="email"], input#email, input[name="email"]');
    const passwordField = document.querySelector('input[type="password"]');
    return !!(emailField && passwordField);
  }

  // ---------------------------------------------------------------------------
  // Tìm ô soạn thảo. Ưu tiên: contenteditable có hint; rồi mọi contenteditable
  // không phải ô tìm kiếm; cuối cùng là [role="textbox"].
  // ---------------------------------------------------------------------------
  const SEARCH_BOX_MARKERS = ['[role="searchbox"]', '[aria-label*="search" i]', '[placeholder*="tìm" i]', "input"];

  function isSearchLike(element) {
    return SEARCH_BOX_MARKERS.some((selector) => {
      try {
        return element.matches(selector) || element.closest(selector);
      } catch {
        return false;
      }
    });
  }

  function collectEditables() {
    const nodes = Array.prototype.slice.call(
      document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'),
    );
    return nodes.filter((node) => isVisible(node) && !isSearchLike(node) && !node.closest("header"));
  }

  /**
   * Chọn ô soạn thảo THEO HAI VÒNG, và vòng hai vẫn bị giới hạn trong [role="main"]:
   *  - Vòng 1: contenteditable có nhãn/placeholder khớp câu chữ của ô đăng bài.
   *  - Vòng 2: ô nhập lớn nằm ở cột bài viết chính.
   * Ô bình luận (bên trong [role="article"]) và khung chat luôn bị loại — nhỡ tay
   * dán bài bán xe vào tin nhắn riêng của khách thì rất phiền.
   */
  function isChatRoute() {
    return /^\/(messages|mr|lite\/messenger)/i.test(location.pathname);
  }

  function isWrongTarget(element) {
    if (isChatRoute()) return true;
    return !!element.closest('[role="article"]');
  }

  function hintMatches(element) {
    const hint = textOf(element);
    return COMPOSER_HINTS.some((phrase) => hint.indexOf(phrase) >= 0);
  }

  function pickComposer(editables) {
    const candidates = editables.filter((node) => !isWrongTarget(node) && !isSubmitLabel(node));
    const withHint = candidates.filter(hintMatches);
    if (withHint.length) return withHint[0];
    const inMainFeed = candidates.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 260 && !!node.closest('[role="main"]');
    });
    return inMainFeed.length ? inMainFeed[0] : null;
  }

  function findOpener() {
    if (isChatRoute()) return null;
    const buttons = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], a[role="link"]'));
    for (const button of buttons) {
      if (!isVisible(button) || isSubmitLabel(button)) continue; // KHÔNG BAO GIỜ lấy nút gửi làm ô mở bài
      const label = textOf(button);
      if (!label) continue;
      if (OPENER_LABELS.some((phrase) => label.indexOf(phrase) >= 0)) return button;
    }
    return null;
  }

  // Click mở composer chỉ nhắm phần tử đã khớp nhãn MỞ bài, có kiểm tra lại nhãn
  // ngay trước khi click để phòng Facebook đổi DOM giữa chừng.
  function openComposer() {
    const opener = findOpener();
    if (!opener) return false;
    if (isSubmitLabel(opener)) return false;
    opener.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  async function waitForComposer(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let triedOpen = false;
    while (Date.now() < deadline) {
      const found = pickComposer(collectEditables());
      if (found) return found;
      if (!triedOpen) {
        triedOpen = openComposer();
        await sleep(900);
        const afterOpen = pickComposer(collectEditables());
        if (afterOpen) return afterOpen;
      }
      await sleep(POLL_MS);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Điền caption. Ba cơ chế giảm dần, mỗi lần thử đều đọc lại để biết cơ chế nào
  // thực sự ăn — không đoán.
  // ---------------------------------------------------------------------------
  function clearComposer(element) {
    element.focus();
    try {
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
    } catch {
      element.textContent = "";
    }
  }

  function typeViaExecCommand(element, caption) {
    element.focus();
    try {
      return document.execCommand("insertText", false, caption);
    } catch {
      return false;
    }
  }

  function pasteViaClipboardEvent(element, caption) {
    try {
      const data = new DataTransfer();
      data.setData("text/plain", caption);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      element.focus();
      return element.dispatchEvent(event);
    } catch {
      return false;
    }
  }

  // Lưới cuối: ghi thẳng vào DOM rồi báo cho React của Facebook bằng InputEvent.
  function insertViaInputEvent(element, caption) {
    try {
      element.focus();
      element.textContent = caption;
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: caption,
          dataTransfer: null,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async function fillCaption(element, caption) {
    const attempts = [typeViaExecCommand, pasteViaClipboardEvent, insertViaInputEvent];
    for (const attempt of attempts) {
      clearComposer(element);
      attempt(element, caption);
      // Facebook cập nhật composer bằng React, không đồng bộ với lệnh điền.
      // Ta quay lại ĐỌC chính ô đó cho tới khi khớp, hoặc hết vòng.
      for (let tick = 0; tick < 20; tick += 1) {
        await sleep(120);
        const ratio = captionFilledRatio(caption, readCaption(pickComposer(collectEditables()) || element));
        if (ratio >= CAPTION_FILL_THRESHOLD) return { filled: true, ratio };
      }
    }
    return { filled: false, ratio: captionFilledRatio(caption, readCaption(element)) };
  }

  // ---------------------------------------------------------------------------
  // Đính kèm ảnh: ưu tiên paste tệp (cách người dùng vẫn làm), rồi tới input[file].
  // Số ảnh "đã đính kèm" chỉ được tính khi trông thấy ảnh xem trước thật.
  // ---------------------------------------------------------------------------
  function toFiles(images) {
    const files = [];
    for (const image of images || []) {
      try {
        const comma = String(image.data || "").indexOf(",");
        const body = (comma >= 0 ? String(image.data).slice(comma + 1) : String(image.data || "")).replace(/\s/g, "");
        const binary = atob(body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        files.push(new File([bytes], image.name || "xe-carem.jpg", { type: image.mime || "image/jpeg" }));
      } catch {
        // Một ảnh hỏng không được làm hỏng cả lượt chuyển.
      }
    }
    return files;
  }

  function countImagePreviews(scope) {
    const root = scope || document;
    const blobs = root.querySelectorAll('img[src^="blob:"]');
    let count = blobs.length;
    if (!count) {
      // Một số bản render dùng thumbnail [role="img"] thay vì <img>.
      count = root.querySelectorAll('[data-uri^="blob:"], [aria-label*="Photo" i][role="img"]').length;
    }
    return count;
  }

  function pasteFiles(element, files) {
    try {
      const data = new DataTransfer();
      for (const file of files) data.items.add(file);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
      element.focus();
      element.dispatchEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  function inputFiles(files) {
    const inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]'));
    const imageInput =
      inputs.find((input) => /image/.test(input.accept || "")) ||
      inputs.find((input) => !input.accept) ||
      null;
    if (!imageInput) return false;
    try {
      const data = new DataTransfer();
      for (const file of files) data.items.add(file);
      imageInput.files = data.files;
      imageInput.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  async function attachImages(element, files, expected, timeoutMs) {
    if (!expected) return { attached: 0, skipped: 0 };
    const deadline = Date.now() + timeoutMs;
    let delivered = false;
    if (pasteFiles(element, files)) delivered = true;
    if (!delivered || !countImagePreviews(element)) {
      // Paste không ăn (phiên bản Facebook chặn) thì thử ngỏ input[file].
      if (inputFiles(files)) delivered = true;
    }
    if (!delivered) return { attached: 0, skipped: files.length };

    let seen = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      seen = Math.max(seen, countImagePreviews(element), countImagePreviews(document));
      if (seen >= expected) break;
    }
    return { attached: seen, skipped: Math.max(0, files.length - seen) };
  }

  // ---------------------------------------------------------------------------
  // Xử lý một lượt điền. Mọi nhánh đều trả về bằng chứng cụ thể.
  // ---------------------------------------------------------------------------
  async function handleFill(request) {
    if (isLoginScreen()) {
      return { ok: false, code: "NOT_LOGGED_IN", captionFilled: false, imagesAttached: 0, imagesExpected: (request.images || []).length };
    }
    const timeoutMs = Math.min(Number(request.timeoutMs) || 30000, 40000);
    const composer = await waitForComposer(Math.floor(timeoutMs * 0.45));
    if (!composer) {
      return { ok: false, code: "COMPOSER_NOT_FOUND", captionFilled: false, imagesAttached: 0, imagesExpected: (request.images || []).length };
    }

    const caption = String(request.caption || "");
    const filled = await fillCaption(composer, caption);
    const expected = (request.images || []).length;
    if (!filled.filled) {
      return {
        ok: false,
        // Bài quá dài là lý do duy nhất Facebook từ chối chữ; ngoài ra coi là
        // composer không nhận nội dung (đổi giao diện, bị chặn, sai ô).
        code: caption.length > 5000 ? "CAPTION_TOO_LONG" : "CAPTION_REJECTED",
        captionFilled: false,
        imagesAttached: 0,
        imagesExpected: expected,
        message: "Tỷ lệ khớp khi đọc lại: " + Math.round(filled.ratio * 100) + "%",
      };
    }

    const liveComposer = pickComposer(collectEditables()) || composer;
    const files = toFiles(request.images);
    let attached = { attached: 0, skipped: 0 };
    if (expected) {
      attached = await attachImages(liveComposer, files, expected, Math.floor(timeoutMs * 0.4));
    }

    // Đọc lại caption LẦN CUỐI sau khi đính kèm ảnh (Facebook có thể render lại composer).
    const finalRatio = captionFilledRatio(caption, readCaption(pickComposer(collectEditables()) || liveComposer));
    const captionOk = finalRatio >= CAPTION_FILL_THRESHOLD;
    if (!captionOk)
      return { ok: false, code: "CAPTION_REJECTED", captionFilled: false, imagesAttached: attached.attached, imagesExpected: expected };

    if (expected && attached.attached < expected)
      return {
        ok: true,
        code: "IMAGES_REJECTED",
        captionFilled: true,
        imagesAttached: attached.attached,
        imagesExpected: expected,
        message: attached.attached ? "Chỉ thấy " + attached.attached + "/" + expected + " ảnh xem trước." : "Không đính kèm tự động được ảnh.",
      };

    return {
      ok: true,
      captionFilled: true,
      imagesAttached: attached.attached || expected,
      imagesExpected: expected,
      code: undefined,
      message: "",
    };
  }

  // Không có đường dẫn nào trong file này gửi click tới nút Đăng. Listener bên
  // dưới chỉ nhận message từ service worker CỦA CHÍNH tiện ích (sender.id khớp),
  // nên một trang giả mạo Facebook hay script bên thứ ba không ra lệnh được.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.channel !== CHANNEL) return false;
    if (!sender || sender.id !== chrome.runtime.id) return false;

    if (message.type === "are-you-there") {
      sendResponse({ channel: CHANNEL, protocol: PROTOCOL, ok: true });
      return false;
    }
    if (message.type !== "fill") return false;
    if (message.protocol !== PROTOCOL) {
      sendResponse({ channel: CHANNEL, ok: false, code: "PROTOCOL_MISMATCH", captionFilled: false, imagesAttached: 0, imagesExpected: 0 });
      return false;
    }

    handleFill(message)
      .then((result) => sendResponse({ channel: CHANNEL, protocol: PROTOCOL, ...result }))
      .catch((error) =>
        sendResponse({
          channel: CHANNEL,
          protocol: PROTOCOL,
          ok: false,
          code: "CONTENT_ERROR",
          captionFilled: false,
          imagesAttached: 0,
          imagesExpected: (message.images || []).length,
          message: error && error.message ? error.message : "",
        }),
      );
    return true;
  });
})();
