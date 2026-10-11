import { describe, expect, it, beforeEach } from "vitest";
import {
  decideDuplicateAction,
  isPrivilegedRole,
  isSaveBlocked,
} from "@/lib/duplicateReviewDecision";
import type { Role } from "@/types";
import type { DuplicateLevel } from "@/lib/vehicleDuplicateCheck";

/**
 * Integration: luồng hoàn chỉnh nghi trùng PLATE_AND_LAST5 (migration
 * 20261011000400) — nối QUYẾT ĐỊNH THUẦN phía client (`decideDuplicateAction`,
 * code thật) với MỘT BẢN MÔ PHỎNG máy trạng thái RPC phía server phản ánh ĐÚNG
 * hợp đồng đã chốt. Nó khoá 5 yêu cầu验收 mà unit + DB test rời rạc chưa khoá
 * chung một chỗ:
 *
 *   1. Bảo toàn toàn bộ dữ liệu (kể ảnh) + KHÔNG tạo xe trước khi duyệt;
 *   2. Không rò rỉ giá vốn riêng tư của Chủ qua payload/response/notification;
 *   3. (resolve) server tái kiểm dữ liệu + đối chiếu + trùng trong transaction;
 *   4. Không tạo yêu cầu trùng; không sinh HAI xe từ một yêu cầu;
 *   5. FULL_FRAME_MATCH chặn tuyệt đối với MỌI vai trò, kể cả đường gửi duyệt.
 *
 * Bản mô phỏng server là test-local (không suy ra từ source runtime); tính ĐÚNG
 * của nó trước PostgreSQL thật do tests/db/duplicate-plate-last5-review.test.mjs
 * đảm nhận. Ở đây ta kiểm CLIENT và SERVER không lệch nhau về hành vi.
 */

const CANDIDATE_PRICE_SECRET = 41_414_141;

type Draft = {
  vehicle_type: string;
  license_plate: string;
  frame_number: string;
  year: number | null;
  color: string;
  seller_name: string;
  purchase_price: number;
  images: string[]; // ảnh đã chụp — phải được bảo toàn nguyên vẹn
};

type Approval = {
  id: string;
  kind: "VEHICLE_DUPLICATE_REVIEW";
  subject_id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string;
  requested_by: string;
  requester_name: string;
  payload: {
    mode: "ACQUIRE" | "SAVE";
    candidate_ids: string[];
    requested_data: Draft;
    staff_note: string;
  };
};

type Vehicle = { id: string; draft: Draft; overridden_by?: string };

// Máy trạng thái mô phỏng server: một xe đối chiếu đã tồn tại, kèm giá vốn riêng tư.
class ServerSim {
  candidateId = "veh-candidate";
  candidatePrice = CANDIDATE_PRICE_SECRET; // giá vốn RIÊNG TƯ của Chủ — không lộ
  approvals: Approval[] = [];
  vehicles: Vehicle[] = [];
  private seq = 0;

  constructor(
    public dupLevel: DuplicateLevel,
    public dupReason: string,
    public candidateIds: string[],
  ) {}

  // check_vehicle_duplicates: chỉ trả chữ ký nhận diện, KHÔNG có giá vốn.
  check(): {
    level: DuplicateLevel;
    reason: string;
    candidate_ids: string[];
  } {
    return {
      level: this.dupLevel,
      reason: this.dupReason,
      candidate_ids: this.candidateIds,
    };
  }

  // request_vehicle_duplicate_review: tạo ĐƠN CHỜ, KHÔNG tạo xe. Chặn đơn trùng
  // theo (kind, subject_id) khi đang PENDING — mô phỏng approval_open_unique.
  request(draft: Draft, requester: { id: string; name: string }): string {
    const subjectId = this.candidateIds[0];
    if (
      this.approvals.some(
        (a) => a.status === "PENDING" && a.subject_id === subjectId,
      )
    )
      throw new Error("ALREADY_PENDING");
    const id = `appr-${++this.seq}`;
    this.approvals.push({
      id,
      kind: "VEHICLE_DUPLICATE_REVIEW",
      subject_id: subjectId,
      status: "PENDING",
      reason: "Nghi trùng: cùng biển số và 5 ký tự cuối số khung.",
      requested_by: requester.id,
      requester_name: requester.name,
      // Lưu snapshot ĐẦY ĐỦ (bao gồm ảnh) để lúc duyệt replay đúng bản nhân viên soạn.
      payload: {
        mode: "ACQUIRE",
        candidate_ids: this.candidateIds,
        requested_data: structuredClone(draft),
        staff_note: "",
      },
    });
    return id;
  }

  // resolve_vehicle_duplicate_review: trong MỘT "transaction" tái kiểm tra đơn còn
  // PENDING, ứng viên còn nghi trùng, rồi tạo ĐÚNG MỘT xe. APPROVE bắt buộc lý do.
  resolve(
    actor: Role,
    approvalId: string,
    action: "APPROVE" | "REJECT",
    reason: string | undefined,
  ): { approval_id: string; action: string; vehicle_id: string | null } {
    if (!isPrivilegedRole(actor)) throw new Error("FORBIDDEN");
    const a = this.approvals.find((x) => x.id === approvalId);
    if (!a) throw new Error("NOT_FOUND");
    if (a.status !== "PENDING") throw new Error("ALREADY_RESOLVED");
    if (action === "REJECT") {
      a.status = "REJECTED";
      return { approval_id: a.id, action, vehicle_id: null };
    }
    if (!reason || reason.trim().length < 5)
      throw new Error("DUPLICATE_OVERRIDE_REASON_REQUIRED");
    // Tái kiểm tra trùng trong transaction: dữ liệu ứng viên vẫn khớp nghi trùng.
    if (this.dupReason === "FULL_FRAME_MATCH")
      throw new Error("APPROVAL_STALE_DATA");
    const id = `veh-${++this.seq}`;
    this.vehicles.push({ id, draft: structuredClone(a.payload.requested_data) });
    a.status = "APPROVED";
    return { approval_id: a.id, action, vehicle_id: id };
  }

  // acquire_vehicle (đường Chủ/Quản lý lưu ngoại lệ trực tiếp): server buộc FULL
  // không bao giờ qua; PLATE cần lý do + hồ sơ đã đối chiếu ∈ candidate.
  acquire(
    actor: Role,
    draft: Draft,
    override?: { reason: string; reviewedVehicleId: string },
  ): string {
    const action = decideDuplicateAction({
      level: this.dupLevel,
      reason: this.dupReason,
      role: actor,
    });
    if (action.kind === "hard-block") throw new Error("FULL_FRAME_BLOCKED");
    if (action.kind === "request-review") throw new Error("REVIEW_REQUIRED");
    if (action.kind === "override-save") {
      if (!override || override.reason.trim().length < 5)
        throw new Error("DUPLICATE_OVERRIDE_REASON_REQUIRED");
      if (!this.candidateIds.includes(override.reviewedVehicleId))
        throw new Error("NO_DUPLICATE_TO_REVIEW");
    }
    const id = `veh-${++this.seq}`;
    this.vehicles.push({ id, draft: structuredClone(draft), overridden_by: actor });
    return id;
  }

  // list_vehicle_duplicate_reviews: hàng đợi OWNER/MANAGER, đã stripping giá vốn.
  list(actor: Role): { items: Approval[]; total: number } {
    if (!isPrivilegedRole(actor)) throw new Error("FORBIDDEN");
    const items = this.approvals.filter((a) => a.status === "PENDING");
    return { items: structuredClone(items), total: items.length };
  }
}

const draft: Draft = {
  vehicle_type: "Xe số",
  license_plate: "59N1-555.55",
  frame_number: "RLHJDUPCAND989",
  year: 2024,
  color: "Trắng",
  seller_name: "Người bán Z",
  purchase_price: 30_000_000,
  images: ["vehicle-images/a.jpg", "vehicle-images/b.jpg"],
};

let server: ServerSim;
beforeEach(() => {
  server = new ServerSim("RED", "PLATE_AND_LAST5", ["veh-candidate"]);
});

describe("Luồng STAFF nghi trùng PLATE_AND_LAST5 → gửi yêu cầu", () => {
  it("client quyết định request-review và server không tạo xe trước duyệt", () => {
    const action = decideDuplicateAction({
      level: "RED",
      reason: "PLATE_AND_LAST5",
      role: "STAFF",
    });
    expect(action.kind).toBe("request-review");
    expect(isSaveBlocked(action)).toBe(true);

    const before = server.vehicles.length;
    const id = server.request(draft, { id: "staff-1", name: "Nhân viên A" });
    expect(id).toBeTruthy();
    expect(server.vehicles.length).toBe(before); // (1) KHÔNG tạo xe
    expect(server.approvals[0].payload.requested_data).toEqual(draft); // (1) bảo toàn đủ, gồm ảnh
  });

  it("không cho tạo yêu cầu trùng cho cùng hồ sơ đang chờ", () => {
    server.request(draft, { id: "staff-1", name: "Nhân viên A" });
    expect(() =>
      server.request(draft, { id: "staff-1", name: "Nhân viên A" }),
    ).toThrow("ALREADY_PENDING"); // (4) không trùng yêu cầu
    expect(server.approvals).toHaveLength(1);
  });
});

describe("FULL_FRAME_MATCH chặn tuyệt đối mọi vai trò", () => {
  const full = () => new ServerSim("RED", "FULL_FRAME_MATCH", ["veh-candidate"]);

  for (const role of ["STAFF", "MANAGER", "OWNER"] as Role[]) {
    it(`${role}: hard-block, không lưu, cũng không có đường gửi duyệt`, () => {
      const action = decideDuplicateAction({
        level: "RED",
        reason: "FULL_FRAME_MATCH",
        role,
      });
      expect(action.kind).toBe("hard-block"); // không phải request-review
      expect(isSaveBlocked(action)).toBe(true);
      const s = full();
      expect(() => s.acquire(role, draft)).toThrow("FULL_FRAME_BLOCKED");
      // hard-block nghĩa là UI không mở hộp thoại gửi yêu cầu; ngay cả khi cố
      // gọi thẳng, APPROVE cũng bị từ chối vì dữ liệu stale.
      const id = s.request(draft, { id: "x", name: "y" });
      expect(() => s.resolve("OWNER", id, "APPROVE", "lý do đủ dài")).toThrow(
        "APPROVAL_STALE_DATA",
      );
      expect(s.vehicles).toHaveLength(0);
    });
  }
});

describe("OWNER/MANAGER lưu ngoại lệ trực tiếp", () => {
  it("buộc lý do ≥ 5 ký tự và hồ sơ đối chiếu thuộc candidate", () => {
    expect(() => server.acquire("OWNER", draft)).toThrow(
      "DUPLICATE_OVERRIDE_REASON_REQUIRED",
    );
    expect(() =>
      server.acquire("OWNER", draft, { reason: "abc", reviewedVehicleId: "veh-candidate" }),
    ).toThrow("DUPLICATE_OVERRIDE_REASON_REQUIRED");
    expect(() =>
      server.acquire("OWNER", draft, { reason: "lý do hợp lệ", reviewedVehicleId: "khac" }),
    ).toThrow("NO_DUPLICATE_TO_REVIEW");

    const id = server.acquire("OWNER", draft, {
      reason: "Đã mở hồ sơ, xác nhận hai xe khác nhau.",
      reviewedVehicleId: "veh-candidate",
    });
    expect(server.vehicles.map((v) => v.id)).toContain(id);
    expect(server.vehicles.find((v) => v.id)!.draft).toEqual(draft); // bảo toàn
  });

  it("STAFF không được lưu ngoại lệ (chỉ gửi duyệt)", () => {
    const action = decideDuplicateAction({
      level: "RED",
      reason: "PLATE_AND_LAST5",
      role: "STAFF",
    });
    expect(action.kind).not.toBe("override-save");
  });
});

describe("Duyệt trong hàng đợi: một yêu cầu → đúng một xe", () => {
  it("APPROVE tạo đúng MỘT xe; APPROVE lần hai bị chặn, không sinh xe thứ hai", () => {
    const id = server.request(draft, { id: "staff-1", name: "Nhân viên A" });
    const res = server.resolve("MANAGER", id, "APPROVE", "Đã đối chiếu thực tế.");
    expect(res.vehicle_id).toBeTruthy();
    expect(server.vehicles).toHaveLength(1);

    expect(() =>
      server.resolve("OWNER", id, "APPROVE", "duyệt lại vẫn sai"),
    ).toThrow("ALREADY_RESOLVED");
    expect(server.vehicles).toHaveLength(1); // (4) không hai xe từ một yêu cầu
  });

  it("REJECT không tạo/đổi xe nào", () => {
    const id = server.request(draft, { id: "staff-1", name: "Nhân viên A" });
    const res = server.resolve("MANAGER", id, "REJECT", undefined);
    expect(res.vehicle_id).toBeNull();
    expect(server.vehicles).toHaveLength(0);
  });

  it("STAFF không xử lý được hàng đợi (RBAC)", () => {
    const id = server.request(draft, { id: "staff-1", name: "Nhân viên A" });
    expect(() => server.resolve("STAFF", id, "APPROVE", "không có quyền")).toThrow(
      "FORBIDDEN",
    );
  });
});

describe("Tài chính riêng tư: giá vốn của Chủ không lộ qua hàng đợi", () => {
  it("payload/response/list không chứa giá vốn xe đối chiếu", () => {
    server.request(draft, { id: "staff-1", name: "Nhân viên A" });
    const serialized = JSON.stringify(server.list("MANAGER"));
    expect(serialized).not.toContain(String(CANDIDATE_PRICE_SECRET)); // (2)
    expect(serialized).not.toContain("candidatePrice");
    // Ảnh và dữ liệu nhận diện của XE MỚI (nhân viên soạn) thì phải còn nguyên.
    expect(serialized).toContain("vehicle-images/a.jpg");
    expect(serialized).toContain("59N1-555.55");
  });
});
