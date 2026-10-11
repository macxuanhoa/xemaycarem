// Service worker MV3 của "Cà Rem · Cầu đăng Facebook".
//
// Nhiệm vụ DUY NHẤT: nhận caption + ảnh từ trang CRM (đã được Chrome chốt
// quyền qua `externally_connectable`), đưa sang một tab Facebook, rồi chuyển
// KẾT QUẢ ĐÃ KIỂM CHỨNG trở lại trang. Không đọc cookie, không đọc localStorage
// của Facebook, không gọi API Facebook, và không bao giờ bấm nút Đăng.
//
// Ảnh chỉ đi qua bộ nhớ tạm của worker trong thời gian ngắn và không được ghi
// xuống bất kỳ đâu (chrome.storage / file) — hết lượt chia sẻ là hết dữ liệu.

const CHANNEL = "carem-fb-share";
const PROTOCOL = 1;

const LIMITS = {
  captionChars: 5000,
  images: 8,
  imageBytes: 4 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  // Thời gian content script có toàn bộ để tìm + điền + đọc lại composer.
  fillTimeoutMs: 40000,
  readyTimeoutMs: 20000,
};

const DATA_IMAGE = /^data:image\/(png|jpe?g|webp);base64,/;

/** Origin được phép nói chuyện với tiện ích — khớp manifest, phòng hờ lệch cấu hình. */
const ALLOWED_HOSTS = new Set([
  "carem.vercel.app",
  "xemaycarem.vercel.app",
  "localhost",
  "127.0.0.1",
]);

function reply(type, extra) {
  return { channel: CHANNEL, protocol: PROTOCOL, type, ...extra };
}

function fail(code, message) {
  return reply("share-result", {
    ok: false,
    captionFilled: false,
    imagesAttached: 0,
    imagesExpected: 0,
    code,
    message: message || "",
  });
}

function isAllowedSender(sender) {
  const raw = sender && (sender.tab ? sender.tab.url : sender.url);
  if (!raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) return false;
  // localhost/127.0.0.1 chỉ là môi trường dev → chấp nhận http; production bắt buộc https.
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.protocol === "http:" || url.protocol === "https:";
  return url.protocol === "https:";
}

function approxBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((body.length * 3) / 4);
}

/**
 * Kiểm tra lại toàn bộ hợp đồng ngay tại cửa extension. Trang web đã kiểm một
 * lần, nhưng tiện ích không được tin dữ liệu văng tới mà chưa tự soi — đây là
 * chốt chặn cuối trước khi nội dung chạm tới Facebook.
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return "EMPTY_PAYLOAD";
  const caption = String(payload.caption || "");
  if (!caption.trim()) return "EMPTY_CAPTION";
  if (caption.length > LIMITS.captionChars) return "CAPTION_TOO_LONG";
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (images.length > LIMITS.images) return "TOO_MANY_IMAGES";
  let total = 0;
  for (const image of images) {
    const data = image && typeof image.data === "string" ? image.data : "";
    if (!DATA_IMAGE.test(data)) return "BAD_IMAGE";
    const bytes = approxBytes(data);
    if (bytes > LIMITS.imageBytes) return "IMAGE_TOO_LARGE";
    total += bytes;
  }
  if (total > LIMITS.totalBytes) return "TOTAL_TOO_LARGE";
  const target = payload.target === "GROUP" ? "GROUP" : "PERSONAL";
  if (target === "GROUP" && !isSafeGroupUrl(payload.groupUrl)) return "BAD_GROUP_URL";
  return null;
}

function isSafeGroupUrl(value) {
  const raw = (value || "").trim();
  if (!raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hostname !== "www.facebook.com" && url.hostname !== "facebook.com") return false;
  return /^\/(groups|share)\//i.test(url.pathname);
}

function targetUrl(payload) {
  if (payload.target === "GROUP" && isSafeGroupUrl(payload.groupUrl)) return payload.groupUrl;
  return "https://www.facebook.com/";
}

/**
 * Chọn tab Facebook: ưu tiên tab ĐANG MỞ đúng nơi cần đăng (hội nhóm), rồi tới
 * tab Facebook đang ở trang có ô đăng bài, cuối cùng mới mở tab mới. Không đóng
 * tab của người dùng và không bao giờ đụng tab không phải Facebook.
 * `needNavigate` = phải chờ load lại trước khi điền.
 */
async function resolveTab(payload) {
  const wanted = targetUrl(payload);
  const tabs = await chrome.tabs.query({ url: "https://www.facebook.com/*" });

  if (tabs.length) {
    // Hội nhóm: chỉ giữ tab khi nó đã thực sự ở trong nhóm đó.
    if (payload.target === "GROUP") {
      const inGroup = tabs.find((tab) => tab.url && payload.groupUrl && tab.url.startsWith(payload.groupUrl));
      if (inGroup && inGroup.id) return { tab: inGroup, needNavigate: false };
      const first = tabs.find((tab) => tab.id);
      if (first) return { tab: await chrome.tabs.update(first.id, { url: wanted, active: true }), needNavigate: true };
    } else {
      const usable = tabs.find(
        (tab) => tab.id && tab.url && !/\/(login|logout|recover|sharer|checkpoint)\b/i.test(tab.url),
      );
      const chosen = usable || tabs.find((tab) => tab.id);
      if (chosen) return { tab: chosen, needNavigate: chosen.status !== "complete" };
    }
  }

  const created = await chrome.tabs.create({ url: wanted, active: true });
  return { tab: created, needNavigate: true };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (tab) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(tab);
    };
    const listener = (id, changeInfo, tab) => {
      if (id === tabId && changeInfo.status === "complete") finish(tab);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // Tab có thể đã load xong trước khi ta kịp đăng ký listener.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") finish(tab);
    }).catch(() => undefined);
  });
}

/**
 * Content script được khai trong manifest, nhưng tab mở từ trước hoặc trang
 * Facebook chuyển qua SPA có thể chưa có. Hỏi nhẹ, không trả lời thì bơm bằng
 * `scripting` — cùng một file, không có nhánh logic khác.
 */
async function ensureContentScript(tabId) {
  try {
    const ack = await chrome.tabs.sendMessage(tabId, { channel: CHANNEL, type: "are-you-there" });
    if (ack && ack.channel === CHANNEL) return true;
  } catch {
    // chưa có content script → inject
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const ack = await chrome.tabs.sendMessage(tabId, { channel: CHANNEL, type: "are-you-there" });
    return !!(ack && ack.channel === CHANNEL);
  } catch {
    return false;
  }
}

/**
 * Giữ service worker sống trong lúc chờ content script. MV3 cho worker nghỉ sau
 * một khoảng ngắn, mà một lượt điền + kiểm chứng có thể kéo dài tới 40 giây; nếu
 * worker chết giữa chừng thì lời hứa trả về kết quả bị mất. Chrome reset đồng hồ
 * idle mỗi khi gọi API extension, nên ta gọi một API rẻ (`getPlatformInfo`) theo
 * vòng — đây là liệu pháp chống nghỉ, KHÔNG phải tính năng, và là best-effort.
 */
function startKeepAlive() {
  let alive = true;
  const timer = setInterval(() => {
    if (!alive) return;
    try {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    } catch {
      clearInterval(timer);
    }
  }, 15000);
  // Gọi một lần ngay để worker " tỉnh" trước khi vào chuỗi await dài.
  try {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  } catch {
    // bỏ qua: worker đã sống
  }
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

async function handleShare(payload) {
  const invalid = validatePayload(payload);
  if (invalid) return fail(invalid);

  let stopKeepAlive = () => undefined;
  try {
    const { tab, needNavigate } = await resolveTab(payload);
    if (!tab || !tab.id) return fail("NO_FACEBOOK_TAB");
    stopKeepAlive = startKeepAlive();

    if (needNavigate) {
      const ready = await waitForTabComplete(tab.id, LIMITS.readyTimeoutMs);
      if (!ready) return fail("TAB_LOAD_TIMEOUT");
    }
    const hasScript = await ensureContentScript(tab.id);
    if (!hasScript) return fail("CONTENT_SCRIPT_UNAVAILABLE");

    const result = await chrome.tabs.sendMessage(tab.id, {
      channel: CHANNEL,
      protocol: PROTOCOL,
      type: "fill",
      caption: payload.caption,
      images: payload.images || [],
      vehicleLabel: payload.vehicleLabel || "",
      timeoutMs: LIMITS.fillTimeoutMs,
    });

    if (!result || result.channel !== CHANNEL) return fail("CONTENT_SCRIPT_NO_REPLY");
    return reply("share-result", {
      ok: !!result.ok,
      captionFilled: !!result.captionFilled,
      imagesAttached: Number(result.imagesAttached || 0),
      imagesExpected: Number(result.imagesExpected || (payload.images || []).length),
      code: result.code || (result.ok ? undefined : "FILL_FAILED"),
      message: result.message || "",
    });
  } catch (error) {
    const message = error && error.message ? error.message : "";
    if (/Unchecked runtime.lastError|Could not establish connection/.test(message))
      return fail("CONTENT_SCRIPT_UNAVAILABLE");
    return fail("EXTENSION_ERROR", message);
  } finally {
    stopKeepAlive();
  }
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (!message || message.channel !== CHANNEL || (type !== "ping" && type !== "share")) return false;
  if (!isAllowedSender(sender)) {
    sendResponse(reply("share-result", { ok: false, code: "ORIGIN_NOT_ALLOWED", captionFilled: false, imagesAttached: 0, imagesExpected: 0 }));
    return false;
  }
  if (message.protocol !== PROTOCOL) {
    sendResponse(reply("share-result", { ok: false, code: "PROTOCOL_MISMATCH", captionFilled: false, imagesAttached: 0, imagesExpected: 0 }));
    return false;
  }
  if (message.type === "ping") {
    sendResponse(reply("pong", { ok: true }));
    return false;
  }
  // Giữ cổng message mở cho tới khi có kết quả đã kiểm chứng từ Facebook.
  handleShare(message.payload).then(sendResponse).catch((error) => {
    sendResponse(fail("EXTENSION_ERROR", error && error.message ? error.message : ""));
  });
  return true;
});
