// Bộ giải chuyển động cột sống rồng — trái tim của "chuyển động thật".
//
// Nguyên tắc điện ảnh: ĐẦU dẫn đường, thân mình tuân theo theo trễ pha có
// quán tính. Đầu rồng bay một quỹ đạo 3D được biên đạo trước (Bezier phân
// đoạn theo 6 cảnh); phần thân là một chuỗi khớp cứng được ràng buộc mỗi
// khung hình — khớp sau luôn cách khớp trước đúng một khoảng đốt sống và chỉ
// được TRƯỢT dọc chính nó. Đó là cách một con rắn/thân rồng thật bò: khi đầu
// dừng, thân nằm lại tại chỗ cho tới khi luồng chuyển động chạy hết chiều
// dài, chứ không co cụm về phía đầu.
//
// Song song với chuỗi ràng buộc: (1) lượn sóng thân tự nhiên (undulation) do
// caller cộng vào, (2) banking/nghiêng người khi rẽ, (3) up-vector vận chuyển
// song song (parallel transport) để thân không bao giờ xoắn gãy.

import { Matrix4, Quaternion, Vector3 } from "three";

export type SpineFrame = {
  position: Vector3;
  quaternion: Quaternion;
  forward: Vector3;
  up: Vector3;
  right: Vector3;
  /** Bán kính thân tại đốt này (đã gồm taper). */
  radius: number;
};

const UP_FALLBACK = new Vector3(0, 1, 0);
const TMP_M = new Matrix4();

/** Biên dạng bán kính thân: cổ đầy đặn → mình vạm vỡ → thon dần → đuôi mảnh. */
export function bodyRadius(t: number, base: number): number {
  // t: 0 ở cổ (sau đầu) → 1 ở chóp đuôi.
  const chest = 1 - Math.pow(Math.min(1, Math.max(0, t - 0.12) * 1.15), 1.6);
  const taper = Math.pow(1 - Math.min(1, t), 0.62);
  return base * Math.max(0.045, (0.52 + 0.48 * chest) * taper);
}

export class SpineSolver {
  /** Vị trí khớp đang sống, duy trì giữa các khung hình (0 = sau đầu). */
  private readonly joints: Vector3[] = [];
  private readonly spacing: number;
  private readonly count: number;
  private readonly prevHead = new Vector3();
  private readonly dir = new Vector3();
  private readonly mid = new Vector3();
  private ready = false;

  constructor(spacing: number, segments: number) {
    this.spacing = spacing;
    this.count = segments;
    for (let i = 0; i < segments; i += 1) this.joints.push(new Vector3());
  }

  /** Xếp thân thành một đường thẳng phía sau đầu để bắt đầu từ tư thế hợp lệ. */
  private layOut(head: Vector3) {
    this.dir.set(0, 0, -1);
    for (let i = 0; i < this.count; i += 1) {
      this.joints[i].copy(head).addScaledVector(this.dir, i * this.spacing);
    }
    this.prevHead.copy(head);
    this.ready = true;
  }

  /** Nạp trước hồ sơ "quá khứ" để rồng vào cảnh đã dài đầy thân. */
  warmup(
    getHeadPos: (t: number, out: Vector3) => Vector3,
    from: number,
    span: number,
    out: Vector3[],
  ) {
    const tmp = new Vector3();
    const samples = Math.ceil(span * 60);
    for (let i = 0; i <= samples; i += 1) {
      // from là thời điểm trễ nhất (âm); tiến dần về 0 (giờ G).
      const t = from + (span * i) / samples;
      this.follow(getHeadPos(t, tmp), out);
    }
  }

  /**
   * Một bước lan truyền: khớp 0 bám sát đầu, mỗi khớp sau chỉ được trượt
   * dọc chính nó để giữ đúng `spacing` so với khớp trước.
   *
   * Khác biệt cốt lõi so với "lấy mẫu lại đường bay theo cung": khi đầu
   * dừng lại (phút đáp xuống chữ), thân NẰM LẠI TẠI CHỖ đúng như rắn thật
   * đang bò, chứ không cuộn tròn về phía đầu. Nhờ vậy tư thế chiến thắng
   * giữ được một con rồng trải dài thay vì một nắm dây thần.
   */
  follow(head: Vector3, out: Vector3[]): void {
    if (!this.ready) this.layOut(head);
    // Hướng tham chiếu khi một khớp bị trùng khít khớp trước (đầu mới dừng).
    this.dir.subVectors(head, this.prevHead);
    if (this.dir.lengthSq() < 1e-8) this.dir.set(0, 0, -1);
    else this.dir.normalize();
    this.prevHead.copy(head);
    // Khớp gốc PHẢI bám đầu mỗi khung hình. Quét bên dưới luôn đặt khớp i
    // so với khớp i-1 qua `this.joints`, nên nếu không ghi lại đây thì
    // joints[0] mãi mãi là vị trí lúc layOut — toàn thân nối đúng vào một
    // điểm chết, đầu + bờm + râu đóng băng ở nơi rồng xuất hiện. (Bất biến
    // này từng vỡ im lặng suốt các cảnh bay — xem debug.headGap().)
    this.joints[0].copy(head);

    for (let pass = 0; pass < 3; pass += 1) {
      out[0].copy(head);
      for (let i = 1; i < this.count; i += 1) {
        const prev = i === 1 ? out[0] : this.joints[i - 1];
        const cur = this.joints[i];
        this.mid.subVectors(cur, prev);
        const len = this.mid.length();
        if (len < 1e-5) cur.copy(prev).addScaledVector(this.dir, -this.spacing);
        else cur.copy(prev).addScaledVector(this.mid, this.spacing / len);
      }
      // Mềm hoá: mỗi khớp (trừ đầu) bị kéo về phía trung điểm hai láng giềng
      // rồi khôi phục khoảng cách. Đây là độ cứng uốn giả lập của một thân
      // rồng liền mạch, diệt các nếp gấp sắc khi đầu quặt gấp.
      //
      // Ba lượt (quét → mềm → quét → mềm → quét) là bắt buộc: một lượt mềm
      // chưa đủ phá hết góc gập, mà góc nhỏ hơn đường kính thân thì hai đoạn
      // ống chồng lên nhau và thành một khối bẹp. Lượt cuối chỉ quét khoảng
      // cách nên thân trở về đúng chuẩn đốt sống sau khi đã vuốt cong.
      if (pass < 2) {
        for (let i = this.count - 1; i > 0; i -= 1) {
          const a = this.joints[i - 1];
          const b = this.joints[Math.min(i + 1, this.count - 1)];
          this.mid.addVectors(a, b).multiplyScalar(0.5);
          this.joints[i].lerp(this.mid, 0.3);
        }
      }
    }
    for (let i = 0; i < this.count; i += 1) out[i].copy(this.joints[i]);
  }
}

/**
 * Dựng khung hình đốt sống (position/quaternion/up/right/forward) từ dãy
 * điểm thân đã có vị trí cuối cùng (sau undulation): forward theo tiếp
 * tuyến, up vận chuyển song song, banking khi rẽ, làm mượt theo thời gian.
 */
export class FrameBuilder {
  private readonly smoothUp: Vector3;
  private readonly f = new Vector3();
  private readonly turn = new Vector3();
  private readonly right0 = new Vector3();

  constructor() {
    this.smoothUp = new Vector3(0, 1, 0);
  }

  build(points: Vector3[], frames: SpineFrame[], bankGain: number): void {
    const count = frames.length;
    // Up bắt đầu từ up thế giới rồi vận chuyển dọc chuỗi: mỗi bước chiếu lên
    // mặt phẳng vuông góc forward — không gãy xoắn khi rồng lộn vòng.
    let upInitialized = false;
    for (let i = 0; i < count; i += 1) {
      const p = points[i];
      const next = points[Math.min(i + 1, count - 1)];
      const prev = points[Math.max(i - 1, 0)];
      this.f.subVectors(prev, next);
      if (this.f.lengthSq() < 1e-8) this.f.set(0, 0, 1);
      this.f.normalize();
      if (!upInitialized) {
        this.smoothUp.set(0, 1, 0);
        upInitialized = true;
      }
      // banking: thành phần đạo hàm forward theo ngang thân nghiêng up vào
      // trong cua — như mô tô ngả khi quặt, rồng ngả khi lượn.
      if (i > 0) {
        this.turn.subVectors(this.f, frames[i - 1].forward);
        this.right0.crossVectors(this.f, this.smoothUp);
        if (this.right0.lengthSq() > 1e-6) {
          this.right0.normalize();
          this.smoothUp.addScaledVector(this.right0, -this.turn.dot(this.right0) * bankGain);
        }
      }
      this.smoothUp.addScaledVector(this.f, -this.smoothUp.dot(this.f));
      if (this.smoothUp.lengthSq() < 1e-6) {
        this.smoothUp.copy(UP_FALLBACK).addScaledVector(this.f, -UP_FALLBACK.dot(this.f));
      }
      this.smoothUp.normalize();

      const frame = frames[i];
      frame.right.crossVectors(this.f, this.smoothUp).normalize();
      frame.position.copy(p);
      frame.forward.copy(this.f);
      frame.up.copy(this.smoothUp);
      frame.quaternion.setFromRotationMatrix(
        // Quy ước nhân vật: +Z là hướng bơi tới (thân rồng chạy dần về -Z),
        // nên eye = p + forward, center = p.
        TMP_M.lookAt(p.clone().add(this.f), p, this.smoothUp),
      );
    }
  }
}

export function makeFrames(count: number): SpineFrame[] {
  return Array.from({ length: count }, () => ({
    position: new Vector3(),
    quaternion: new Quaternion(),
    forward: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    right: new Vector3(1, 0, 0),
    radius: 0.3,
  }));
}
