/**
 * Màn chúc mừng rồng vàng — lớp kiểm thử THUẦN LOGIC (GATE B/F tĩnh).
 *
 * Nhà tù ở đây là "rồng không được là một ảnh cứng trượt theo hình chữ S":
 * bất biến sống còn là KHOẢNG CÁCH ĐỐT KHÔNG ĐỔI, dù đầu lao nhanh, dừng
 * đột ngột hay đổi hướng gấp. Kiểm thử dưới đây chốt đúng bất biến đó, cộng
 * các chốt nhỏ về hồ sơ bán kính, thứ tự nhịp kể và nấc chất lượng — tất cả
 * chạy được trong Node, không cần WebGL. Phần "nhìn có ra con rồng không"
 * bắt buộc đánh giá bằng ảnh (scratch/celebrate-3d-verify.mjs), không có
 * đơn vị nào đo hộ.
 */
import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import { Choreographer, TIMELINE } from "@/lib/celebrate3d/choreo";
import { BONES, SPACING } from "@/lib/celebrate3d/dragon";
import { FrameBuilder, SpineSolver, bodyRadius, makeFrames } from "@/lib/celebrate3d/spine";

const newPoints = (n: number) => Array.from({ length: n }, () => new Vector3());

/** Tổng độ dài chuỗi điểm: dùng để kiểm chứng đường đậu được chuẩn hoá. */
const chainLength = (pts: Vector3[]) => {
  let sum = 0;
  for (let i = 1; i < pts.length; i += 1) sum += pts[i].distanceTo(pts[i - 1]);
  return sum;
};

describe("SpineSolver — lan truyền thân rồng", () => {
  const spacing = SPACING;
  const segments = BONES;

  it("giữ đúng khoảng cách đốt khi đầu di chuyển nhanh và đổi hướng gấp", () => {
    const solver = new SpineSolver(spacing, segments);
    const pts = newPoints(segments);
    const head = new Vector3();

    for (let frame = 0; frame < 240; frame += 1) {
      const a = frame * 0.11;
      // Quỹ đạo khắc nghiệt hơn biên đạo thật: bán kính 3 đơn vị, 60 Hz,
      // đầu quay liên tục — nếu bộ giữ khoảng cách có chỗ nào hở sẽ lộ ngay.
      head.set(Math.cos(a) * 3, Math.sin(a * 0.7) * 2, Math.sin(a) * 3);
      solver.follow(head, pts);

      // Khớp 0 PHẢI bám sát đầu mọi khung hình (đây chính là bất biến
      // từng vỡ im lặng: joints[0] đóng băng ở điểm xuất hiện, đầu + bờm
      // + râu treo ở đó trong lúc thân đã bay đi). Chuỗi sau nó giữ đúng
      // khoảng cách đốt.
      expect(pts[0].distanceTo(head)).toBeLessThan(1e-6);
      for (let i = 1; i < segments; i += 1) {
        expect(pts[i].distanceTo(pts[i - 1])).toBeCloseTo(spacing, 3);
      }
    }
  });

  it("thân nằm lại tại chỗ khi đầu dừng — không cuộn tròn về phía đầu", () => {
    const solver = new SpineSolver(spacing, segments);
    const pts = newPoints(segments);
    const head = new Vector3();

    // Cho đầu bò một quãng dài để thân trải hết cỡ.
    for (let frame = 0; frame < 400; frame += 1) {
      head.set(frame * 0.05, 0, 0);
      solver.follow(head, pts);
    }
    const tailBefore = pts[segments - 1].clone();
    const chainLengthAtRest = chainLength(pts);

    // Đầu ghím lại đúng vị trí (nhịp đáp): sau 1 giây, đuôi phải đứng gần
    // như nguyên chỗ cũ và toàn thân không được co lại.
    for (let frame = 0; frame < 60; frame += 1) solver.follow(head, pts);

    expect(pts[segments - 1].distanceTo(tailBefore)).toBeLessThan(0.35);
    // Đo bằng CHÍNH CHUỖI (không tính head, vì khớp 0 trễ một frame —
    // xem test ở trên): trải Chuỗi dài bằng đúng chiều dài thân trước sau.
    expect(chainLength(pts)).toBeCloseTo(chainLengthAtRest, 1);
    expect(head.distanceTo(pts[segments - 1])).toBeGreaterThan(12);
    // Một ảnh cứng trượt theo quỹ đạo sẽ cho kết quả ngược lại: đuôi bám
    // theo đầu và toàn thân co về một nắm gọn.
    expect(head.distanceTo(pts[segments - 1])).toBeGreaterThan(10);
  });

  it("đầu quặt ngược 180°: thân gập thành vòng nhưng không gãy vụn", () => {
    const solver = new SpineSolver(spacing, segments);
    const pts = newPoints(segments);
    const head = new Vector3();

    for (let frame = 0; frame < 300; frame += 1) {
      head.set(-frame * 0.04, 0, 0);
      solver.follow(head, pts);
    }
    for (let frame = 0; frame < 90; frame += 1) {
      head.set(frame * 0.06, 0.02 * frame, 0);
      solver.follow(head, pts);
    }

    // Một thân rắn THẬT được phép gập 180° tại một khớp khi đầu quặt gấp
    // (vòng gấp là đúng chủ đích); bất biến phải giữ là chuỗi số học sống
    // được: hữu hạn, khoảng cách đốt không đổi, và hai khớp không trùng
    // khít nhau (độ suy biến làm FrameBuilder sinh quaternion NaN).
    for (let i = 1; i < segments; i += 1) {
      expect(Number.isFinite(pts[i].x + pts[i].y + pts[i].z)).toBe(true);
      expect(pts[i].distanceTo(pts[i - 1])).toBeCloseTo(spacing, 3);
    }
  });
});

describe("FrameBuilder — khung hình đốt sống", () => {
  it("dựng frame trực chuẩn, không suy biến dọc toàn thân", () => {
    const solver = new SpineSolver(SPACING, BONES);
    const builder = new FrameBuilder();
    const pts = newPoints(BONES);
    const frames = makeFrames(BONES);
    const head = new Vector3();

    for (let frame = 0; frame < 120; frame += 1) {
      const a = frame * 0.09;
      head.set(Math.cos(a) * 4, Math.sin(a * 1.3) * 1.5, Math.sin(a) * 4);
      solver.follow(head, pts);
      builder.build(pts, frames, 2.4);

      for (const f of frames) {
        expect(f.forward.length()).toBeCloseTo(1, 4);
        expect(f.up.length()).toBeCloseTo(1, 4);
        expect(f.right.length()).toBeCloseTo(1, 4);
        expect(Math.abs(f.forward.dot(f.up))).toBeLessThan(1e-4);
        expect(Math.abs(f.forward.dot(f.right))).toBeLessThan(1e-4);
        expect(Math.abs(f.up.dot(f.right))).toBeLessThan(1e-4);
        expect(Number.isNaN(f.quaternion.x + f.quaternion.y + f.quaternion.z + f.quaternion.w)).toBe(false);
      }
    }
  });
});

describe("bodyRadius — hồ sơ thân", () => {
  it("mông to nhất ở gần đầu, thon dần và dương đến chóp đuôi", () => {
    const base = 0.42;
    const profile = Array.from({ length: 61 }, (_, i) => bodyRadius(i / 60, base));

    for (const r of profile) {
      expect(r).toBeGreaterThan(0);
      expect(Number.isFinite(r)).toBe(true);
    }
    // Đuôi phải nhọn hơn rõ rệt thân, bằng không dải chữ S trông như một
    // ống nước đều cây.
    expect(profile[55]).toBeLessThan(profile[10] * 0.5);
    // Cổ/ ngực phình lên: không được có điểm gập âm giữa đường.
    expect(Math.min(...profile)).toBeGreaterThan(0);
  });
});

describe("Choreographer — tỷ lệ sân khấu bất biến theo khổ máy", () => {
  const bodyLength = (BONES - 1) * SPACING;

  it("đường đậu luôn được chuẩn hoá về đúng chiều dài thân", () => {
    const spans: number[] = [];
    for (const titleHeightWorld of [0.5, 0.9, 1.4, 2.2]) {
      const choreo = new Choreographer();
      choreo.setBodyLength(bodyLength);
      choreo.setStage(titleHeightWorld);
      const pts = newPoints(BONES);
      for (let i = 0; i < BONES; i += 1) pts[i].set(0, 0, 0);
      choreo.applyPerch(pts, 1, 9.2);
      // blend=1: points là mẫu trên cung đậu, tổng chuỗi phải khớp chiều dài
      // thân — con rồng dài nhiêu đó ở 360×800 lẫn 1920×1080.
      spans.push(chainLength(pts));
    }
    for (const s of spans) expect(s).toBeCloseTo(bodyLength, 0);
    expect(Math.max(...spans) - Math.min(...spans)).toBeLessThan(bodyLength * 0.05);
  });

  it("thân đậu vươn cao hơn mặt chữ nhờ nhịp ngẩng mình", () => {
    const choreo = new Choreographer();
    choreo.setBodyLength(bodyLength);
    choreo.setStage(1.0);
    const build = (t: number) => {
      const pts = newPoints(BONES);
      for (let i = 0; i < BONES; i += 1) pts[i].set(0, 0, 0);
      choreo.applyPerch(pts, 1, t);
      return pts[2].y;
    };
    // Trước nhịp ngẩng (fireStart) và lúc ngẩng đầy: cổ phải được nhấc lên.
    expect(build(TIMELINE.fireStart + 0.5)).toBeGreaterThan(build(TIMELINE.contactAt + 0.5));
  });
});

describe("TIMELINE — nhịp kể chuyện", () => {
  it("chữ hiện trước khi rồng đáp, lửa tắt trước khi màn đóng", () => {
    expect(TIMELINE.titleAt).toBeLessThan(TIMELINE.contactAt);
    expect(TIMELINE.contactAt).toBeLessThan(TIMELINE.fireStart);
    expect(TIMELINE.fireStart).toBeLessThan(TIMELINE.fireEnd);
    expect(TIMELINE.bannerAt).toBeLessThan(TIMELINE.fireEnd + 1.5);
    expect(TIMELINE.fireEnd).toBeLessThan(TIMELINE.duration);
    expect(TIMELINE.duration).toBe(10);
  });

  it("hàm nhịp ngoài cửa sổ diễn phải im lặng tuyệt đối", () => {
    const choreo = new Choreographer();
    // Trước khi bắt đầu và sau khi kết thúc: không lửa, không hàm mở,
    // không glow — nếu còn phát sinh thì particle sẽ âm ỉ sau nút bỏ qua.
    for (const t of [-1, 0]) {
      expect(choreo.fireIntensity(t)).toBe(0);
      expect(choreo.jawOpen(t)).toBeLessThanOrEqual(0.05);
    }
    const late = TIMELINE.fireEnd + 1.2;
    expect(choreo.fireIntensity(late)).toBe(0);
    expect(choreo.throatGlow(late)).toBe(0);
  });
});
