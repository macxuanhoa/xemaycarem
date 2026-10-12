import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PwaUpdate } from "@/components/PwaUpdate";
import { NetworkGuard } from "@/components/NetworkGuard";
import { describeAction } from "@/features/audit/auditLabels";

// Mock virtual:pwa-register/react
let needRefreshMock = false;
const updateServiceWorkerMock = vi.fn();

vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({
    needRefresh: [needRefreshMock, vi.fn()],
    updateServiceWorker: updateServiceWorkerMock,
  }),
}));

// Mock @/lib/networkStatus
let networkOnlineMock = true;

vi.mock("@/lib/networkStatus", () => ({
  useNetworkStatus: () => ({
    online: networkOnlineMock,
    browserOnline: networkOnlineMock,
    checking: false,
    serviceStatus: networkOnlineMock ? "ready" : "unavailable",
    offlineSince: networkOnlineMock ? 0 : 1000,
  }),
  retryConnection: vi.fn().mockResolvedValue(true),
}));

describe("PwaUpdate - Màn hình cập nhật deploy trang trắng & logo điện sáng", () => {
  beforeEach(() => {
    needRefreshMock = false;
    updateServiceWorkerMock.mockReset();
  });

  it("không render khi chưa có bản deploy mới", () => {
    needRefreshMock = false;
    const html = renderToStaticMarkup(<PwaUpdate />);
    expect(html).toBe("");
  });

  it("render trang trắng với logo Cà Rem, sóng điện và dòng chữ cập nhật khi có bản mới", () => {
    needRefreshMock = true;
    const html = renderToStaticMarkup(<PwaUpdate />);
    expect(html).toContain("carem-pwa-update-screen");
    expect(html).toContain("Bấm vào logo để cập nhật ứng dụng");
    expect(html).toContain("/logo.jpg");
    expect(html).toContain("carem-electric-waves");
    expect(html).toContain("carem-electric-arcs");
  });
});

describe("NetworkGuard - Ngắn gọn: Kiểm tra lại kết nối mạng + countdown", () => {
  it("render ngắn gọn tiêu đề 'Kiểm tra lại kết nối mạng' và countdown khi offline", () => {
    networkOnlineMock = false;
    const html = renderToStaticMarkup(<NetworkGuard />);
    expect(html).toContain("Kiểm tra lại kết nối mạng");
    expect(html).toContain("Tự thử lại sau 5s");
    expect(html).toContain("network-countdown-text");
  });

  it("không hiển thị banner lỗi khi online", () => {
    networkOnlineMock = true;
    const html = renderToStaticMarkup(<NetworkGuard />);
    expect(html).not.toContain("Kiểm tra lại kết nối mạng");
  });
});

describe("Nhất quán Audit Labels - Cà Rem nhập", () => {
  it("chuẩn hóa hiển thị khi role chủ cửa hàng hoặc hệ thống nhập xe/giá/thu tiền thành 'Cà Rem nhập'", () => {
    expect(describeAction("CREATE_ACQUISITION", "Hệ thống")).toBe(
      "Cà Rem nhập đã thu một xe vào kho"
    );
    expect(describeAction("CREATE_VEHICLE", "Chủ cửa hàng")).toBe(
      "Cà Rem nhập đã nhập một xe vào kho"
    );
    expect(describeAction("CREATE_PAYMENT", "Hệ thống")).toBe(
      "Cà Rem nhập đã ghi nhận một khoản thu"
    );
    expect(describeAction("UPDATE_VEHICLE", "")).toBe(
      "Cà Rem nhập đã cập nhật thông tin xe"
    );
    // Nhân viên thông thường vẫn giữ nguyên tên nhân viên
    expect(describeAction("CREATE_ACQUISITION", "Nguyễn Văn A")).toBe(
      "Nguyễn Văn A đã thu một xe vào kho"
    );
  });
});
