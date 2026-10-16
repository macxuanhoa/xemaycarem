import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Hợp đồng "tải ảnh về máy" cho CCCD và ảnh xe.
 *
 * Repo này không có jsdom, nên môi trường trình duyệt được dựng bằng
 * vi.stubGlobal và mô-đun được nạp lại sau mỗi ca (vi.resetModules) vì
 * imageSave ghi nhớ kết quả thăm dò canShare cùng bộ đệm ảnh trong module
 * state. Phần cuối chốt thẳng vào mã nguồn: tên class giao diện phát ra phải
 * có thật trong styles.css, vì đây chính là kiểu hỏng "nút không có kiểu" mà
 * các bản kiểm tra UI trước đã bắt.
 */

const UA = {
  desktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ bật "Trang desktop": báo là máy Mac nhưng vẫn có cảm ứng.
  ipadDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
};

type Stub = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  canShareFiles?: boolean;
  /** Hành vi của navigator.share; mặc định thành công. */
  shareError?: Error;
};

/**
 * Dựng một "trình duyệt" tối giản: máy ghi lại ảnh đã chia sẻ và tệp đã bấm tải,
 * cùng số lượt fetch gọi đi.
 */
function stubBrowser({
  userAgent = UA.desktop,
  platform = "Win32",
  maxTouchPoints = 0,
  canShareFiles = false,
  shareError,
}: Stub = {}) {
  const shared: { files?: File[]; title?: string }[] = [];
  const downloaded: { name: string; href: string }[] = [];
  const fetches: string[] = [];
  const anchor = {
    href: "",
    download: "",
    rel: "",
    click() {
      downloaded.push({ name: this.download, href: this.href });
    },
    remove() {},
  };
  const share = async (data: { files?: File[]; title?: string }) => {
    if (shareError) throw shareError;
    shared.push(data);
  };
  vi.stubGlobal("navigator", {
    userAgent,
    platform,
    maxTouchPoints,
    canShare: (data: { files?: File[] }) =>
      !!data.files?.length && canShareFiles,
    share,
  });
  vi.stubGlobal("document", {
    createElement: () => anchor,
    body: { append: () => {} },
  });
  // Chỉ cần window tồn tại để imageSave gọi setTimeout dọn blob URL.
  vi.stubGlobal("window", { setTimeout: () => 0 });
  // URL thật của Node đã có createObjectURL/revokeObjectURL: giữ nguyên để
  // không phá bộ phân giải mô-đun của vite ngay trong cùng ca kiểm tra.
  /** Chuyển hành vi của fetch mà không cần dựng lại cả trình duyệt giả. */
  const net = { fail: false };
  vi.stubGlobal("fetch", async (url: string) => {
    fetches.push(String(url));
    if (String(url).includes("missing"))
      return { ok: false, status: 403, blob: async () => new Blob([]) };
    if (net.fail) throw new TypeError("Failed to fetch");
    return {
      ok: true,
      blob: async () =>
        new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
          type: "image/jpeg",
        }),
    };
  });
  return { shared, downloaded, fetches, net };
}

/** imageSave nhớ kết quả thăm dò + bộ đệm ảnh trong module state → nạp mới mỗi ca. */
async function freshImageSave() {
  vi.resetModules();
  return import("@/lib/imageSave");
}

const phoneShare = {
  userAgent: UA.iphone,
  platform: "iPhone",
  maxTouchPoints: 5,
};
const androidShare = {
  userAgent: UA.android,
  platform: "Linux armv8l",
  maxTouchPoints: 5,
  canShareFiles: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("tên tệp ảnh", () => {
  it("đuôi theo MIME, ưu tiên hơn đường dẫn kho", async () => {
    const { extensionForImage } = await freshImageSave();
    expect(extensionForImage("image/jpeg", "a/x.png")).toBe("jpg");
    expect(extensionForImage("image/png")).toBe("png");
    expect(extensionForImage("image/webp")).toBe("webp");
    expect(extensionForImage("image/heic")).toBe("heic");
  });

  it("không có MIME thì đọc đuôi khỏi đường dẫn, kể cả chữ hoa và query string", async () => {
    const { extensionForImage } = await freshImageSave();
    expect(
      extensionForImage(undefined, "vehicle-images/a/b/01.JPG?token=x"),
    ).toBe("jpg");
    expect(extensionForImage(undefined, "vehicle-images/a/b/01.jpeg")).toBe(
      "jpg",
    );
    expect(
      extensionForImage(undefined, "identity-documents/a/front.webp"),
    ).toBe("webp");
  });

  it("đuôi lạ hoặc thiếu đều về jpg để hệ điều hành vẫn mở được ảnh", async () => {
    const { extensionForImage } = await freshImageSave();
    expect(extensionForImage(undefined, "identity/a/front.pdf")).toBe("jpg");
    expect(extensionForImage(undefined, "identity/a/noext")).toBe("jpg");
    expect(extensionForImage("", "")).toBe("jpg");
  });

  it("tên tệp không dấu, không khoảng trắng, giữ được nghĩa tiếng Việt", async () => {
    const { safeFileName } = await freshImageSave();
    expect(safeFileName("CCCD Người bán Mặt trước", "jpg")).toBe(
      "CCCD-NGUOI-BAN-MAT-TRUOC.jpg",
    );
    expect(safeFileName("hồ Chí Minh — ảnh 3", "png")).toBe(
      "HO-CHI-MINH-ANH-3.png",
    );
    expect(safeFileName("  ###  ", "jpg")).toBe("ANH.jpg");
  });

  it("tên dài bị cắt mà không để lại dấu gạch nối cụt ở đuôi", async () => {
    const { safeFileName } = await freshImageSave();
    const name = safeFileName(`Xe ${"A".repeat(120)} ảnh 9`, "jpg");
    expect(name.endsWith("-.jpg")).toBe(false);
    expect(name.length).toBeLessThanOrEqual("ANH.jpg".length + 60);
  });
});

describe("nhận diện thiết bị", () => {
  it("máy tính không phải điện thoại nên đi đường tải tệp bình thường", async () => {
    stubBrowser();
    const { readSaveEnvironment, prefersPhotoLibrary } = await freshImageSave();
    expect(readSaveEnvironment()).toEqual({
      phone: false,
      ios: false,
      canShareFiles: false,
    });
    expect(prefersPhotoLibrary()).toBe(false);
  });

  it("Android và iPhone đều là điện thoại; chỉ iPhone báo ios", async () => {
    stubBrowser(androidShare);
    const mod = await freshImageSave();
    expect(mod.readSaveEnvironment()).toMatchObject({
      phone: true,
      ios: false,
    });

    stubBrowser(phoneShare);
    vi.resetModules();
    const next = await freshImageSave();
    expect(next.readSaveEnvironment()).toMatchObject({
      phone: true,
      ios: true,
    });
  });

  it("iPad để chế độ 'Trang desktop' vẫn bị bắt là máy tính bảng cảm ứng", async () => {
    stubBrowser({
      userAgent: UA.ipadDesktop,
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    const { readSaveEnvironment } = await freshImageSave();
    expect(readSaveEnvironment()).toMatchObject({ phone: true, ios: true });
  });

  it("điện thoại có bảng chia sẻ tệp thì ảnh đi qua Bộ sưu tập", async () => {
    stubBrowser({ ...phoneShare, canShareFiles: true });
    const { prefersPhotoLibrary } = await freshImageSave();
    expect(prefersPhotoLibrary()).toBe(true);
  });

  it("trình duyệt nhúng không chia sẻ được tệp: không phải đường Bộ sưu tập", async () => {
    stubBrowser(phoneShare);
    const { prefersPhotoLibrary } = await freshImageSave();
    expect(prefersPhotoLibrary()).toBe(false);
  });
});

describe("saveImageToDevice", () => {
  it("máy tính tải tệp về, đúng tên tệp đọc được", async () => {
    const env = stubBrowser();
    const { saveImageToDevice } = await freshImageSave();
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/vehicle/a.jpg",
        nameBase: "Wave RSX ảnh 3",
      }),
    ).resolves.toBe("download");
    expect(env.fetches).toHaveLength(1);
    expect(env.downloaded).toHaveLength(1);
    expect(env.downloaded[0]).toMatchObject({
      name: "WAVE-RSX-ANH-3.jpg",
    });
    expect(env.downloaded[0]?.href).toMatch(/^blob:/);
    expect(env.shared).toHaveLength(0);
  });

  it("Android mở bảng chia sẻ của máy để người dùng lưu vào ảnh", async () => {
    const env = stubBrowser(androidShare);
    const { saveImageToDevice } = await freshImageSave();
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/vehicle/a.jpg",
        nameBase: "Wave RSX ảnh 3",
        title: "Wave RSX — ảnh 3/12",
      }),
    ).resolves.toBe("photo-library");
    expect(env.shared).toHaveLength(1);
    expect(env.shared[0]?.title).toBe("Wave RSX — ảnh 3/12");
    expect(env.shared[0]?.files?.[0]?.name).toBe("WAVE-RSX-ANH-3.jpg");
    expect(env.downloaded).toHaveLength(0);
  });

  it("iPhone mở được bảng chia sẻ cũng đi cùng đường Bộ sưu tập", async () => {
    const env = stubBrowser({ ...phoneShare, canShareFiles: true });
    const { saveImageToDevice } = await freshImageSave();
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/identity/front.png",
        nameBase: "CCCD Người bán Mặt trước",
      }),
    ).resolves.toBe("photo-library");
    expect(env.shared[0]?.files?.[0]?.type).toBe("image/jpeg");
  });

  it("iPhone không có bảng chia sẻ: trả long-press và KHÔNG tải tệp sang FILES", async () => {
    const env = stubBrowser(phoneShare);
    const { saveImageToDevice } = await freshImageSave();
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/identity/front.png",
        nameBase: "CCCD Người bán Mặt trước",
      }),
    ).resolves.toBe("long-press");
    expect(env.downloaded).toHaveLength(0);
    // Không tốn một lượt tải cho đường người dùng sẽ không dùng.
    expect(env.fetches).toHaveLength(0);
  });

  it("người dùng tự đóng bảng chia sẻ là cancelled, không phải lỗi", async () => {
    const env = stubBrowser({
      ...androidShare,
      shareError: Object.assign(new Error("closed"), { name: "AbortError" }),
    });
    const { saveImageToDevice } = await freshImageSave();
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/vehicle/a.jpg",
        nameBase: "Wave RSX ảnh 3",
      }),
    ).resolves.toBe("cancelled");
    expect(env.downloaded).toHaveLength(0);
  });

  it("máy từ chối chia sẻ dạng ảnh này: Android tải tệp, iPhone nhấn giữ", async () => {
    const notSupported = Object.assign(new Error("unsupported"), {
      name: "NotAllowedError",
    });
    stubBrowser({ ...androidShare, shareError: notSupported });
    const android = await freshImageSave();
    await expect(
      android.saveImageToDevice({
        url: "https://cdn.example/vehicle/a.jpg",
        nameBase: "Wave RSX ảnh 3",
      }),
    ).resolves.toBe("download");

    stubBrowser({
      ...phoneShare,
      canShareFiles: true,
      shareError: notSupported,
    });
    vi.resetModules();
    const ios = await freshImageSave();
    await expect(
      ios.saveImageToDevice({
        url: "https://cdn.example/vehicle/a.jpg",
        nameBase: "Wave RSX ảnh 3",
      }),
    ).resolves.toBe("long-press");
  });

  it("ảnh không tải được thì báo lỗi tiếng Việt có hướng xử lý", async () => {
    stubBrowser();
    const { saveImageToDevice } = await freshImageSave();
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/missing.jpg",
        nameBase: "Wave RSX ảnh 3",
      }),
    ).rejects.toThrow("Không tải được ảnh về máy. Hãy thử lại.");
  });

  it("gom ảnh sẵn thì lần bấm không phải chờ tải lại", async () => {
    const env = stubBrowser({ ...phoneShare, canShareFiles: true });
    const { warmImageForSave, saveImageToDevice } = await freshImageSave();
    warmImageForSave("https://cdn.example/vehicle/a.jpg");
    await vi.waitFor(() => expect(env.fetches).toHaveLength(1));
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/vehicle/a.jpg",
        nameBase: "Wave RSX ảnh 3",
      }),
    ).resolves.toBe("photo-library");
    expect(env.fetches).toHaveLength(1);
  });

  it("máy tính không gom ảnh sớm (không có quyền chạm để chia sẻ)", async () => {
    const env = stubBrowser();
    const { warmImageForSave } = await freshImageSave();
    warmImageForSave("https://cdn.example/vehicle/a.jpg");
    await Promise.resolve();
    expect(env.fetches).toHaveLength(0);
  });

  it("bấm ngay khi ảnh còn đang gom cũng chỉ tải đúng một lượt", async () => {
    const env = stubBrowser({ ...phoneShare, canShareFiles: true });
    const { warmImageForSave, saveImageToDevice } = await freshImageSave();
    warmImageForSave("https://cdn.example/vehicle/a.jpg");
    // Không chờ lượt gom chạy xong: cú chạm rơi đúng lúc đang tải dở.
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/vehicle/a.jpg",
        nameBase: "Wave RSX ảnh 3",
      }),
    ).resolves.toBe("photo-library");
    expect(env.fetches).toHaveLength(1);
  });

  it("tên tệp theo lần bấm, không theo lần gom: hai ảnh chung một liên kết ký", async () => {
    const env = stubBrowser({ ...phoneShare, canShareFiles: true });
    const { warmImageForSave, saveImageToDevice } = await freshImageSave();
    // Ảnh xe được gom sẵn bằng tên của thư viện xe…
    warmImageForSave("https://cdn.example/shared.jpg");
    await vi.waitFor(() => expect(env.fetches).toHaveLength(1));
    // …nhưng mặt CCCD bấm sau thì tệp phải mang tên hồ sơ CCCD.
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/shared.jpg",
        nameBase: "CCCD Người bán Mặt trước",
      }),
    ).resolves.toBe("photo-library");
    expect(env.shared[0]?.files?.[0]?.name).toBe(
      "CCCD-NGUOI-BAN-MAT-TRUOC.jpg",
    );
    expect(env.fetches).toHaveLength(1);
  });

  it("lượt gom hỏng không bị ghi nhớ, lần bấm sau vẫn tải lại được", async () => {
    const env = stubBrowser({ ...phoneShare, canShareFiles: true });
    env.net.fail = true;
    const { warmImageForSave, saveImageToDevice } = await freshImageSave();
    warmImageForSave("https://cdn.example/vehicle/a.jpg");
    await vi.waitFor(() => expect(env.fetches).toHaveLength(1));
    // Cho lượt hỏng kịp bị xoá khỏi bộ đệm trước khi bấm lại.
    await new Promise((resolve) => setTimeout(resolve, 0));
    env.net.fail = false;
    await expect(
      saveImageToDevice({
        url: "https://cdn.example/vehicle/a.jpg",
        nameBase: "Wave RSX ảnh 3",
      }),
    ).resolves.toBe("photo-library");
    expect(env.fetches).toHaveLength(2);
  });

  it("lỗi khi gom ảnh sớm phải im lặng, không bật toast ngoài ý muốn", async () => {
    const env = stubBrowser({ ...phoneShare, canShareFiles: true });
    env.net.fail = true;
    const { warmImageForSave } = await freshImageSave();
    expect(() =>
      warmImageForSave("https://cdn.example/vehicle/a.jpg"),
    ).not.toThrow();
    await vi.waitFor(() => expect(env.fetches).toHaveLength(1));
  });
});

describe("câu chữ sau một lần lưu", () => {
  it("mở bảng lưu thì phải nói thêm bước cuối người dùng tự chọn", async () => {
    const { saveOutcomeToast } = await freshImageSave();
    expect(saveOutcomeToast("photo-library")).toEqual({
      title: "Đã mở bảng lưu của máy.",
      description: "Chọn “Lưu vào Ảnh” để ảnh hiện trong Bộ sưu tập.",
    });
  });

  it("tải tệp xong nói gọn là đã tải về; tự đóng hoặc nhấn giữ thì im lặng", async () => {
    stubBrowser();
    const { saveOutcomeToast } = await freshImageSave();
    expect(saveOutcomeToast("download")).toEqual({
      title: "Đã tải ảnh về máy.",
    });
    expect(saveOutcomeToast("cancelled")).toBeNull();
    expect(saveOutcomeToast("long-press")).toBeNull();
  });
});

describe("hợp đồng nguồn của hai mục có nút tải ảnh", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const css = read("src/styles.css");

  it("CCCD và ảnh xe cùng dùng một đường lưu ảnh chung", () => {
    const cccd = read("src/components/IdentityDocumentPanel.tsx");
    const photos = read("src/features/vehicles/VehiclePhoto.tsx");
    for (const source of [cccd, photos]) {
      expect(source).toContain("saveImageToDevice");
      expect(source).toContain("saveOutcomeToast");
      expect(source).toContain("PhotoSaveSheet");
      expect(source).toContain("long-press");
    }
  });

  it("mỗi nút tải ảnh có nhãn đọc được cho trình đọc màn hình", () => {
    const cccd = read("src/components/IdentityDocumentPanel.tsx");
    const photos = read("src/features/vehicles/VehiclePhoto.tsx");
    expect(cccd).toContain(
      "aria-label={`Tải ảnh CCCD ${label.toLowerCase()} về máy`}",
    );
    expect(photos).toContain(
      "aria-label={`Tải ảnh ${current + 1}/${count} về máy`}",
    );
  });

  it("styles.css định nghĩa đủ mọi class hai chỗ đó phát ra", () => {
    const emitted = [
      "identity-slot-actions",
      "identity-slot-save",
      "vehicle-display-save",
      "photo-save-sheet",
      "photo-save-sheet-backdrop",
      "photo-save-sheet-lead",
      "photo-save-sheet-img",
      "photo-save-sheet-caption",
    ];
    for (const name of emitted) expect(css).toContain(`.${name}`);
  });

  it("khung nhấn giữ phải mở menu ngữ cảnh của ảnh, nếu không iOS không lưu được", () => {
    const sheet = css.slice(css.indexOf(".photo-save-sheet-img"));
    expect(sheet.slice(0, 400)).toContain("-webkit-touch-callout: default");
  });
});
