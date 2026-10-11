// Unit tests cho "Smart Facebook Share" (src/lib/fbShare).
//
// Vitest chạy ở môi trường node (không có DOM), nên mọi test ở đây chỉ chạm vào
// phần THUẦN/DI của bộ máy: kiểm payload, thăm dò môi giả lập, chiến lược nhận
// runtime giả, bridge nhận window giả. Phần chỉ chạy được trong trình duyệt thật
// (canvas nén ảnh, navigator.share, content script trên facebook.com) được kiểm
// bằng e2e/kiểm tay — không ở file này.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const imageUrl = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { imageUrl } }));

import {
  CAPTION_FILL_THRESHOLD,
  FB_SHARE_LIMITS,
  FB_SHARE_PROTOCOL_VERSION,
  captionFilledRatio,
  dataUrlToBytes,
  safeGroupUrl,
  validateSharePayload,
} from "@/lib/fbShare/protocol";
import type { ShareImage } from "@/lib/fbShare/protocol";
import { chooseStrategy, readPlatform, readShareEnv } from "@/lib/fbShare/detect";
import type { Platform, ShareEnv, ShareEnvSource } from "@/lib/fbShare/detect";
import { SHARE_STAGES, emptyOutcome, isVerifiedByFacebook, stageLabels } from "@/lib/fbShare/status";
import { buildStrategies, describeExtensionCode, runShare } from "@/lib/fbShare/strategies";
import type { ShareRuntime } from "@/lib/fbShare/strategies";
import { rejectionMessage } from "@/lib/fbShare/service";
import { cachedImageCount, clearShareImageCache, prepareShareImages, primeShareImages, sanitizeFileName } from "@/lib/fbShare/images";

const jpeg = (bytes: number) => `data:image/jpeg;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;
const image = (bytes = 1024): ShareImage => ({ name: "xe-1.jpg", mime: "image/jpeg", data: jpeg(bytes) });
const payloadOf = (over: Record<string, unknown> = {}) => ({
  caption: "Wave Alpha 2023 đen, biển 43D1-111.22\nGhé quán cà phê nhé ☕️",
  images: [image()],
  target: "PERSONAL",
  request: "req-1",
  ...over,
});

describe("fbShare payload gate", () => {
  it("giữ nguyên xuống dòng và emoji của caption, không tự biên tập", () => {
    const checked = validateSharePayload(payloadOf() as never);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.caption).toContain("\nGhé quán cà phê nhé ☕️");
  });
  it("chặn caption rỗng và quá dài thay vì cắt âm thầm", () => {
    expect(validateSharePayload(payloadOf({ caption: "   " }) as never)).toMatchObject({ ok: false, code: "EMPTY_CAPTION" });
    expect(
      validateSharePayload(payloadOf({ caption: "x".repeat(FB_SHARE_LIMITS.captionChars + 1) }) as never),
    ).toMatchObject({ ok: false, code: "CAPTION_TOO_LONG" });
  });
  it("giới hạn số ảnh, cỡ từng ảnh và tổng tải trọng", () => {
    const many = Array.from({ length: FB_SHARE_LIMITS.images + 1 }, () => image(64));
    expect(validateSharePayload(payloadOf({ images: many }) as never)).toMatchObject({ ok: false, code: "TOO_MANY_IMAGES" });
    expect(validateSharePayload(payloadOf({ images: [image(FB_SHARE_LIMITS.imageBytes + 10_000)] }) as never))
      .toMatchObject({ ok: false, code: "IMAGE_TOO_LARGE" });
    const fat = Array.from({ length: FB_SHARE_LIMITS.images }, () => image(FB_SHARE_LIMITS.imageBytes - 1000));
    expect(validateSharePayload(payloadOf({ images: fat }) as never)).toMatchObject({ ok: false, code: "TOTAL_TOO_LARGE" });
  });
  it("từ chối ảnh sai định dạng hoặc không phải data-URL", () => {
    expect(validateSharePayload(payloadOf({ images: [{ name: "a.gif", mime: "image/gif", data: jpeg(512) }] }) as never))
      .toMatchObject({ ok: false, code: "BAD_IMAGE" });
    expect(
      validateSharePayload(payloadOf({ images: [{ name: "a.jpg", mime: "image/jpeg", data: "https://cdn.example/a.jpg" }] }) as never),
    ).toMatchObject({ ok: false, code: "BAD_IMAGE" });
  });
  it("chỉ nhận link hội nhóm https của facebook /groups hoặc /share", () => {
    expect(safeGroupUrl("https://www.facebook.com/groups/1234567890/")).toContain("groups");
    expect(safeGroupUrl("https://www.facebook.com/share/g/abcdef/")).toContain("share");
    expect(safeGroupUrl("http://www.facebook.com/groups/1/")).toBeNull();
    expect(safeGroupUrl("javascript:alert(1)")).toBeNull();
    expect(safeGroupUrl("https://evil.example/groups/1")).toBeNull();
    expect(safeGroupUrl("https://www.facebook.com/profile.php?id=1")).toBeNull();
    expect(validateSharePayload(payloadOf({ target: "GROUP" }) as never)).toMatchObject({ ok: false, code: "BAD_GROUP_URL" });
  });
  it("base64 ↔ bytes là vòng无损 để content script dựng File đúng cỡ", () => {
    const source = image(2048);
    const bytes = dataUrlToBytes(source.data);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 2)).toEqual(dataUrlToBytes(source.data).subarray(0, 2));
  });
  it("so khớp caption theo khoảng trắng đã chuẩn hoá, không đòi từng ký tự", () => {
    const want = "Xe ngon   giá tốt\nGhé quán nhé";
    expect(captionFilledRatio(want, "Xe ngon giá tốt Ghé quán nhé")).toBe(1);
    expect(captionFilledRatio(want, "Xe ngon")).toBeLessThan(CAPTION_FILL_THRESHOLD);
    expect(captionFilledRatio(want, "")).toBe(0);
    expect(captionFilledRatio("", "abc")).toBe(0);
  });
});

describe("fbShare environment probe", () => {
  const base: ShareEnvSource = {
    userAgent: "Mozilla/5.0 (Macintosh) Chrome/126",
    maxTouchPoints: 0,
    hasShare: false,
    canShareFiles: false,
    secureContext: true,
    hasClipboard: true,
    extensionReady: false,
  };
  it("phân biệt android/ios/desktop và bắt iPad giả UA Mac", () => {
    expect(readPlatform({ userAgent: "Android 13 Pixel", maxTouchPoints: 5 })).toBe("android");
    expect(readPlatform({ userAgent: "iPhone OS 17", maxTouchPoints: 1 })).toBe("ios");
    expect(readPlatform({ userAgent: "Macintosh; Intel Mac OS X", maxTouchPoints: 0 })).toBe("desktop");
    expect(readPlatform({ userAgent: "Macintosh; Intel Mac OS X", maxTouchPoints: 10 })).toBe("ios");
  });
  it("clipboard chỉ tính trên desktop && secure context; webShareFiles phải được hỏi kèm files", () => {
    const insecure = readShareEnv({ ...base, secureContext: false });
    expect(insecure.clipboard).toBe(false);
    const mobileShare = readShareEnv({ ...base, userAgent: "Android 13", hasShare: true, canShareFiles: true });
    expect(mobileShare.webShareFiles).toBe(true);
    const textOnly = readShareEnv({ ...base, userAgent: "Android 13", hasShare: true, canShareFiles: false });
    expect(textOnly.webShareFiles).toBe(false);
  });
  it("thứ tự ưu tiên: Cầu đăng → share sheet → dán tay, và chỉ mời cài tiện ích trên desktop", () => {
    const desktop = readShareEnv({ ...base });
    expect(chooseStrategy({ ...desktop, extensionReady: true })).toMatchObject({ strategy: "EXTENSION", suggestExtension: false });
    expect(chooseStrategy({ ...desktop, webShare: true })).toMatchObject({ strategy: "NATIVE", suggestExtension: true });
    expect(chooseStrategy(desktop)).toMatchObject({ strategy: "MANUAL", suggestExtension: true });
    const phone = readShareEnv({ ...base, userAgent: "Android 13", hasShare: true, canShareFiles: true });
    expect(chooseStrategy(phone)).toMatchObject({ strategy: "NATIVE", suggestExtension: false });
    const poorPhone = readShareEnv({ ...base, userAgent: "Android 13" });
    expect(chooseStrategy(poorPhone)).toMatchObject({ strategy: "MANUAL" });
  });
  it("HTTP nội bộ không có clipboard thì lời dẫn không hứa 'đã copy'", () => {
    const choice = chooseStrategy(readShareEnv({ ...base, secureContext: false }));
    expect(choice.reason).toContain("tải ảnh");
  });
});

function fakeRuntime(fakeEnv: Partial<ShareEnv> & { platform: Platform }, over: Partial<ShareRuntime> = {}): ShareRuntime {
  const env: ShareEnv = {
    webShare: false, webShareFiles: false, clipboard: true,
    secureContext: true, extensionReady: false, ...fakeEnv,
  };
  return {
    env,
    open: vi.fn(),
    writeClipboard: vi.fn(async () => ({ text: true, images: 1 })),
    share: vi.fn(async () => undefined),
    extensionShare: vi.fn(async () => ({
      type: "share-result" as const, protocol: FB_SHARE_PROTOCOL_VERSION, ok: true,
      captionFilled: true, imagesAttached: 1, imagesExpected: 1,
    })),
    extensionPing: vi.fn(async () => true),
    ...over,
  };
}

describe("fbShare strategies nói đúng mức đã chứng minh", () => {
  const noop = () => undefined;

  it("EXTENSION đọc lại composer và đủ ảnh → READY_FOR_REVIEW, captionFilled = true", async () => {
    const result = await buildStrategies(fakeRuntime({ platform: "desktop", extensionReady: true })).EXTENSION.run(payloadOf() as never, noop);
    expect(result).toMatchObject({ stage: "READY_FOR_REVIEW", strategy: "EXTENSION", captionFilled: true, imagesAttached: 1, imagesExpected: 1 });
    expect(result.detail).toContain("bấm Đăng");
  });
  it("EXTENSION thiếu ảnh → PARTIAL_SUCCESS, bảo người dùng đính kèm thêm", async () => {
    const runtime = fakeRuntime({ platform: "desktop", extensionReady: true }, {
      extensionShare: vi.fn(async () => ({
        type: "share-result" as const, protocol: FB_SHARE_PROTOCOL_VERSION, ok: true,
        captionFilled: true, imagesAttached: 1, imagesExpected: 2,
      })),
    });
    const result = await buildStrategies(runtime).EXTENSION.run(payloadOf({ images: [image(), image()] }) as never, noop);
    expect(result.stage).toBe("PARTIAL_SUCCESS");
    expect(result.detail).toContain("1/2");
  });
  it("EXTENSION failed mang lời dịch từ mã lỗi, không im lặng", async () => {
    const runtime = fakeRuntime({ platform: "desktop", extensionReady: true }, {
      extensionShare: vi.fn(async () => ({
        type: "share-result" as const, protocol: FB_SHARE_PROTOCOL_VERSION, ok: false,
        captionFilled: false, imagesAttached: 0, imagesExpected: 0, code: "COMPOSER_NOT_FOUND",
      })),
    });
    const result = await buildStrategies(runtime).EXTENSION.run(payloadOf() as never, noop);
    expect(result.stage).toBe("FAILED");
    expect(result.detail).toBe(describeExtensionCode("COMPOSER_NOT_FOUND"));
  });
  it("EXTENSION không trả lời (timeout) → FAILED, không rơi vào trạng thái 'đã điền'", async () => {
    const runtime = fakeRuntime({ platform: "desktop", extensionReady: true }, { extensionShare: vi.fn(async () => { throw new Error("SHARE_TIMEOUT"); }) });
    const result = await buildStrategies(runtime).EXTENSION.run(payloadOf() as never, noop);
    expect(result.stage).toBe("FAILED");
    expect(result.captionFilled).toBe(false);
  });
  it("NATIVE chỉ trao cho share sheet → captionFilled luôn false dù chữ đi kèm ảnh", async () => {
    const runtime = fakeRuntime({ platform: "android", webShare: true, webShareFiles: true });
    const result = await buildStrategies(runtime).NATIVE.run(payloadOf() as never, noop);
    expect(result.stage).toBe("READY_FOR_REVIEW");
    expect(result.captionFilled).toBe(false);
    expect(result.strategy).toBe("NATIVE");
  });
  it("NATIVE thiết bị chỉ nhận chữ → PARTIAL_SUCCESS + hướng dẫn tải ảnh", async () => {
    const runtime = fakeRuntime({ platform: "ios", webShare: true, webShareFiles: false });
    const result = await buildStrategies(runtime).NATIVE.run(payloadOf() as never, noop);
    expect(result).toMatchObject({ stage: "PARTIAL_SUCCESS", imagesExpected: 1 });
    expect(result.detail).toContain("tải ảnh");
  });
  it("người dùng tắt bảng chia sẻ là CANCELLED, không phải lỗi", async () => {
    const abort = new DOMException("huỷ", "AbortError");
    const runtime = fakeRuntime({ platform: "android", webShare: true }, { share: vi.fn(async () => { throw abort; }) });
    const result = await buildStrategies(runtime).NATIVE.run(payloadOf() as never, noop);
    expect(result.stage).toBe("CANCELLED");
  });
  it("MANUAL copy chữ + 1 ảnh, mở đúng link hội nhóm, và không bao giờ tự nhận đã đăng", async () => {
    const open = vi.fn();
    const runtime = fakeRuntime({ platform: "desktop" }, { open });
    const result = await buildStrategies(runtime).MANUAL.run(payloadOf({ target: "GROUP", groupUrl: "https://www.facebook.com/groups/123/" }) as never, noop);
    expect(result.stage).toBe("FALLBACK_REQUIRED");
    expect(open).toHaveBeenCalledWith("https://www.facebook.com/groups/123/");
    expect(/đã đăng bài|vừa đăng lên facebook/i.test(result.detail)).toBe(false);
  });
  it("MANUAL khi trình duyệt chặn clipboard → bảo copy tay, không nói 'đã copy'", async () => {
    const runtime = fakeRuntime({ platform: "desktop" }, { writeClipboard: vi.fn(async () => ({ text: false, images: 0 })) });
    const result = await buildStrategies(runtime).MANUAL.run(payloadOf() as never, noop);
    expect(result.detail).toContain("copy tay");
  });
  it("runShare rơi đủ chuỗi Cầu đăng → share sheet → dán tay và ghi lại những nhánh đã thử", async () => {
    const runtime = fakeRuntime({ platform: "desktop", extensionReady: true, webShare: true, webShareFiles: true }, {
      extensionShare: vi.fn(async () => { throw new Error("EXTENSION_ABSENT"); }),
      share: vi.fn(async () => { throw new DOMException("từ chối", "NotAllowedError"); }),
    });
    const stages: string[] = [];
    const run = await runShare(runtime, payloadOf() as never, (stage) => stages.push(stage));
    expect(run.tried).toEqual(["EXTENSION", "NATIVE", "MANUAL"]);
    expect(run.outcome.stage).toBe("FALLBACK_REQUIRED");
    expect(stages).toContain("OPENING");
    expect(stages).toContain("TRANSFERRING");
    // EXTENSION chết trước khi kịp kiểm chứng → không bao giờ được báo "VERIFYING".
    expect(stages).not.toContain("VERIFYING");
  });
  it("runShare dừng ngay khi người dùng huỷ, không nài họ dán tay", async () => {
    const runtime = fakeRuntime({ platform: "desktop", extensionReady: true, webShare: true }, {
      extensionShare: vi.fn(async () => { throw new Error("EXTENSION_ABSENT"); }),
      share: vi.fn(async () => { throw new DOMException("huỷ", "AbortError"); }),
    });
    const open = runtime.open as ReturnType<typeof vi.fn>;
    const run = await runShare(runtime, payloadOf() as never, () => undefined);
    expect(run.tried).toEqual(["EXTENSION", "NATIVE"]);
    expect(run.outcome.stage).toBe("CANCELLED");
    expect(open).not.toHaveBeenCalled();
  });
  it("runShare thành công ngay từ Cầu đăng thì không thử thêm nhánh nào", async () => {
    const runtime = fakeRuntime({ platform: "desktop", extensionReady: true, webShare: true, webShareFiles: true });
    const run = await runShare(runtime, payloadOf() as never, () => undefined);
    expect(run.tried).toEqual(["EXTENSION"]);
    expect(run.outcome.stage).toBe("READY_FOR_REVIEW");
  });
});

describe("fbShare status, bridge and image cache", () => {
  it("chỉ EXTENSION được quyền nói 'Facebook đã nhận'", () => {
    const verified = { ...emptyOutcome("EXTENSION"), captionFilled: true };
    expect(isVerifiedByFacebook(verified)).toBe(true);
    expect(isVerifiedByFacebook({ ...verified, strategy: "NATIVE" })).toBe(false);
    expect(isVerifiedByFacebook({ ...verified, captionFilled: false })).toBe(false);
  });
  it("10 trạng thái, mỗi trạng thái một lời, không lời nào nhận 'đã đăng'", () => {
    expect(SHARE_STAGES).toHaveLength(10);
    for (const stage of SHARE_STAGES) {
      if (stage === "IDLE") continue;
      const label = stageLabels[stage];
      expect(label.length).toBeGreaterThan(8);
      expect(/đã đăng bài|đã lên facebook/i.test(label)).toBe(false);
    }
  });
  it("mỗi mã lỗi có lời dịch riêng, không rơi về câu chung chung", () => {
    const generic = describeExtensionCode(undefined);
    for (const code of ["NOT_LOGGED_IN", "COMPOSER_NOT_FOUND", "CAPTION_REJECTED", "CAPTION_TOO_LONG", "IMAGES_REJECTED", "PROTOCOL_MISMATCH", "TAB_LOAD_TIMEOUT", "CONTENT_SCRIPT_UNAVAILABLE", "ORIGIN_NOT_ALLOWED"]) {
      expect(describeExtensionCode(code)).not.toBe(generic);
    }
    for (const code of ["EMPTY_CAPTION", "CAPTION_TOO_LONG", "TOO_MANY_IMAGES", "BAD_IMAGE", "IMAGE_TOO_LARGE", "TOTAL_TOO_LARGE", "BAD_GROUP_URL"] as const) {
      expect(rejectionMessage(code).length).toBeGreaterThan(10);
    }
  });

  const withWindow = (value: unknown) => vi.stubGlobal("window", value);
  afterEach(() => vi.unstubAllGlobals());

  it("bridge: không có chrome.runtime / sai phiên bản giao thức đều coi như chưa có Cầu đăng", async () => {
    const { pingExtension, requestExtensionShare } = await import("@/lib/fbShare/bridge");
    withWindow({});
    await expect(pingExtension()).resolves.toBe(false);
    await expect(requestExtensionShare(payloadOf() as never)).rejects.toThrow("EXTENSION_ABSENT");
    withWindow({ chrome: { runtime: { sendMessage: (_id: string, _msg: unknown, cb: (r: unknown) => void) => cb({ type: "pong", protocol: 99, ok: true }) } } });
    await expect(pingExtension()).resolves.toBe(false);
    withWindow({ chrome: { runtime: { sendMessage: (_id: string, _msg: unknown, cb: (r: unknown) => void) => cb({ type: "share-result", protocol: FB_SHARE_PROTOCOL_VERSION, ok: true, captionFilled: true, imagesAttached: 0, imagesExpected: 0 }) } } });
    await expect(requestExtensionShare(payloadOf() as never)).resolves.toMatchObject({ ok: true });
  });
  it("bridge: payload gửi đi mang kênh + phiên bản, không mang cookie/token", async () => {
    const sent: unknown[] = [];
    withWindow({
      chrome: {
        runtime: {
          sendMessage: (id: string, message: unknown, cb: (r: unknown) => void) => {
            sent.push(id, message);
            cb({ type: "share-result", protocol: FB_SHARE_PROTOCOL_VERSION, ok: true, captionFilled: true, imagesAttached: 0, imagesExpected: 0 });
          },
        },
      },
    });
    const { requestExtensionShare } = await import("@/lib/fbShare/bridge");
    const payload = payloadOf({ caption: "Chỉ là caption", images: [] }) as never;
    await requestExtensionShare(payload);
    const wire = JSON.stringify(sent);
    expect(wire).toContain(`"protocol":${FB_SHARE_PROTOCOL_VERSION}`);
    expect(wire).toContain("carem-fb-share");
    expect(wire).not.toContain("cookie");
    expect(wire).not.toContain("access_token");
  });

  it("tên ảnh Việt có dấu/ biển số được làm sạch, tuyệt đối không sót mẩu đường dẫn", () => {
    expect(sanitizeFileName("43D1-111.22", 0)).toBe("43D1-111-22-1.jpg");
    expect(sanitizeFileName("Xe tay ga • 2023 • Đen", 2)).toBe("Xe-tay-ga-2023-Đen-3.jpg");
    expect(sanitizeFileName(undefined, 0)).toBe("xe-carem-1.jpg");
    expect(sanitizeFileName("../../etc/passwd", 0)).toBe("etc-passwd-1.jpg");
    expect(sanitizeFileName("", 0)).toBe("xe-carem-1.jpg");
  });

  describe("cache ảnh trong bộ nhớ (giữ user activation cho navigator.share)", () => {
    const bytes = new Uint8Array(512).fill(7);
    beforeEach(() => {
      clearShareImageCache();
      imageUrl.mockReset();
      imageUrl.mockResolvedValue("https://cdn.example.test/signed/photo-1.jpg");
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => new Blob([bytes], { type: "image/jpeg" }),
      })));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      clearShareImageCache();
    });

    it("hâm trước thì lần bấm sau không phải tải lại ảnh", async () => {
      await primeShareImages(["v1/photo-1.jpg"]);
      expect(cachedImageCount(["v1/photo-1.jpg"])).toBe(1);
      const first = await prepareShareImages(["v1/photo-1.jpg"], "43D1-111.22");
      expect(imageUrl).toHaveBeenCalledTimes(1);
      const second = await prepareShareImages(["v1/photo-1.jpg"], "43D1-111.22");
      expect(imageUrl).toHaveBeenCalledTimes(1);
      expect(second.images[0]?.name).toBe("43D1-111-22-1.jpg");
      expect(first.images[0]?.data).toMatch(/^data:image\/jpeg;base64,/);
    });
    it("một ảnh hỏng chỉ bị loại riêng, caption và ảnh còn vẫn đi", async () => {
      imageUrl.mockImplementation(async (path: string) => {
        if (path.includes("bad")) throw new Error("chưa ký được URL");
        return `https://cdn.example.test/signed/${path}`;
      });
      const prepared = await prepareShareImages(["v1/good-1.jpg", "v1/bad-2.jpg"], "xe");
      expect(prepared.images).toHaveLength(1);
      expect(prepared.skipped).toEqual([{ path: "v1/bad-2.jpg", reason: "chưa ký được URL" }]);
    });
    it("ảnh quá giới hạn một lượt được báo rõ là bị bỏ, không âm thầm cắt", async () => {
      const paths = Array.from({ length: FB_SHARE_LIMITS.images + 2 }, (_, index) => `v1/photo-${index}.jpg`);
      const prepared = await prepareShareImages(paths, "xe");
      expect(prepared.images).toHaveLength(FB_SHARE_LIMITS.images);
      expect(prepared.skipped).toHaveLength(2);
      expect(prepared.skipped[0]?.reason).toContain("Vượt giới hạn");
    });
    it("URL ký ngắn hạn không rò rỉ ra ngoài dữ liệu chia sẻ", async () => {
      const prepared = await prepareShareImages(["v1/photo-1.jpg"], "xe");
      const wire = JSON.stringify(prepared.images);
      expect(wire).not.toContain("cdn.example.test");
      expect(wire).not.toContain("token=");
    });
  });
});
