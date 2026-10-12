// Biên đạo 10 giây — "đạo diễn" của cả cảnh quay, tách bạch khỏi kỹ thuật
// render để đọc như một storyboard chạy được. Mỗi cảnh là một đoạn Bezier
// bậc ba có easing riêng (acceleration/deceleration có chủ đích, không phải
// nội suy tuyến tính vô hồn) cộng với các đường cong diễn xuất phụ: hàm
// mở, họng sáng, chân với, sóng thân, lửa, máy quay.
//
// BẢNG CẢNH (khớp yêu cầu sản xuất):
//   1 Hoàng hôn giáng lâm  0.0 – 1.5  rồng từ trên cao lao xuống qua mây
//   2 Xoáy ốc vươn lên     1.5 – 3.2  đổi hướng ở đáy khung, lấy đà bay lên
//   3 Lượn hùng vĩ         3.2 – 5.0  thế hiện toàn thân, đổi độ sâu
//   4 Đáp xuống CHÚC MỪNG  5.0 – 6.9  giảm tốc, móng chạm mặt chữ, nén thân
//   5 Phun lửa về người xem 6.9 – 8.5 ngẩng đầu, há hàm, bùng lửa
//   6 Khoe chiến thắng     8.5 – 10.0 giữ tư thế nghi lễ, pháo finale, mờ dần

import { CatmullRomCurve3, Matrix4, Quaternion, Vector3 } from "three";

const V = new Vector3();
const V2 = new Vector3();
const M = new Matrix4();
const UP = new Vector3(0, 1, 0);
const TMP_Q = new Quaternion();
// Mục tiêu nhìn: chếch xuống dưới khi lấy đà, thẳng ống kính khi phun lửa.
// AIM_FIRE là mục tiêu RIÊNG cho cú phun, lệch hẳn sang phải chứ không nằm
// trên trục ống kính: đầu nhìn thẳng vào người xem thì luồng lửa chạy đúng
// dọc trục nhìn, bị phối cảnh nén lại thành một cái blob trắng ngay tại
// miệng (hạt ở gần ống kính còn phóng to gấp bội). Nghiêng 25 độ là luồng
// lửa trải dài chéo khung hình, mặt rồng vẫn hướng về phía người xem.
const AIM_DOWN = new Vector3(0, -1.4, 12);
const AIM_CAMERA = new Vector3(0, 0.15, 16);
const AIM_FIRE = new Vector3(4.3, 2.6, 11.5);
const AIM_TMP = new Vector3();

const easeInOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Ramp tuyến tính có cửa sổ [from,to]. */
const window01 = (t: number, from: number, to: number) =>
  clamp01((t - from) / Math.max(1e-6, to - from));

type Segment = {
  t0: number;
  t1: number;
  p0: Vector3;
  c0: Vector3;
  c1: Vector3;
  p1: Vector3;
  ease: (x: number) => number;
};

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

/**
 * Hàm điều tiết thời gian Hermite: E(0)=0, E(1)=1, E'(0)=e0, E'(1)=e1.
 *
 * Hai đạo hàm biên được khai báo tường minh và LUÔN DƯƠNG. Đây chính là chỗ
 * quyết định chất chuyển động: easeInOutCubic thông thường có đạo hàm bằng 0
 * ở hai đầu, nghĩa là đầu rồng bị đứng khựng tại mỗi khớp nối giữa hai cảnh;
 * thân đang đuổi tới dồn hết vào một chỗ sẽ gập lại thành nếp gấp tóc như
 * que tính. Giữ tốc độ liên tục qua khớp thì thân luôn là một đường lượn.
 */
const timing = (e0: number, e1: number) => {
  const a = e0 + e1 - 2;
  const b = 3 - 2 * e0 - e1;
  return (x: number) => ((a * x + b) * x + e0) * x;
};

type Key = { p: Vector3; v: Vector3 };
const key = (
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
): Key => ({ p: v(px, py, pz), v: v(vx, vy, vz) });

/**
 * Nối hai khoá bằng một Bezier bậc ba liên tục C1 đúng theo THỜI GIAN:
 *   P'(t0) = a.v và P'(t1) = b.v
 *   ⇒ c0 = a.p + a.v·dt/(3·e0),  c1 = b.p − b.v·dt/(3·e1)
 *
 * Hai đoạn kề nhau dùng CHUNG một vector vận tốc tại khoá giữa nên cả hướng
 * lẫn tốc độ đều khớp khít: đường bay là một cú lượn liền mạch, và chính các
 * vector vận tốc này kể chuyện nhanh/chậm của từng cảnh.
 */
const link = (
  t0: number,
  t1: number,
  a: Key,
  b: Key,
  e0: number,
  e1: number,
): Segment => {
  const dt = t1 - t0;
  return {
    t0,
    t1,
    p0: a.p.clone(),
    c0: a.p.clone().addScaledVector(a.v, dt / (3 * e0)),
    c1: b.p.clone().addScaledVector(b.v, -dt / (3 * e1)),
    p1: b.p.clone(),
    ease: timing(e0, e1),
  };
};

/* ---- CÁC KHOÁ BIÊN ĐẠO -------------------------------------------------
 * Toạ độ tính TƯƠNG ĐỐI so với mép trên khối chữ CHÚC MỪNG (neo sân khấu),
 * không lấy gốc toạ độ thế giới: cao độ chữ trên màn 360×800 và 1920×1080
 * chênh nhau gần hai lần, nên chỉ neo vào chữ mới đảm bảo rồng luôn đáp LÊN
 * chữ chứ không đáp vào một khoảng trời rồi rơi dần xuống. z=0 là mặt phẳng
 * sân khấu nơi khối chữ toạ lạc; máy quay cách 16.6.
 */
const HOVER = key(3.2, 10.5, -7.6, 0.9, -5.2, 3.4); // vào cảnh: trên cao, rất xa
const BOTTOM = key(7.0, -6.5, 2.6, 1.6, -1.0, 2.2); // đáy cú lao, đang hất lên
const RISE = key(-7.6, 4.3, -1.6, -1.4, 2.6, 0.8); // góc trái trên, còn vươn
const APEX = key(7.6, 5.4, -3.6, 4.4, -0.9, -1.2); // xé ngang sang phải, lùi sâu
const APPROACH = key(1.0, 5.45, 1.9, 0.3, -2.6, -0.7); // vòng lại, vào đà đáp
const TOUCHDOWN = key(0, 3.19, 2.15, 0, -0.3, 0.05); // móng chạm mặt chữ
const SETTLE = key(0, 3.02, 2.05, 0, 0.12, 0.02); // khuỵu một nhịp rồi đứng vững
const REAR_UP = key(0, 3.78, 2.55, 0, 0.06, 0.01); // ngẩng đầu tích lửa
const HOLD = key(0, 3.7, 2.5, 0, -0.03, -0.01); // giữ thế chiến thắng

const SEGMENTS: Segment[] = [
  link(0, 1.5, HOVER, BOTTOM, 1.15, 1.0), // 1 giáng lâm: lao nhanh dần
  link(1.5, 3.2, BOTTOM, RISE, 1.0, 1.0), // 2 xoáy ốc vươn lên
  link(3.2, 4.1, RISE, APEX, 1.0, 1.0), // 3a lượn ngang, đổi tầng sâu
  link(4.1, 5.0, APEX, APPROACH, 1.0, 1.0), // 3b vòng gấp trước sân khấu
  link(5.0, 6.55, APPROACH, TOUCHDOWN, 1.0, 0.55), // 4 đáp: hãm thật lực
  link(6.55, 6.9, TOUCHDOWN, SETTLE, 1.0, 1.0), // 4b hồi trọng lượng
  link(6.9, 8.5, SETTLE, REAR_UP, 1.0, 1.0), // 5 ngẩng đầu phun lửa
  link(8.5, 10, REAR_UP, HOLD, 1.0, 1.0), // 6 khoe chiến thắng
];

function bezier(seg: Segment, u: number, out: Vector3) {
  const mu = 1 - u;
  out.set(
    mu * mu * mu * seg.p0.x + 3 * mu * mu * u * seg.c0.x + 3 * mu * u * u * seg.c1.x + u * u * u * seg.p1.x,
    mu * mu * mu * seg.p0.y + 3 * mu * mu * u * seg.c0.y + 3 * mu * u * u * seg.c1.y + u * u * u * seg.p1.y,
    mu * mu * mu * seg.p0.z + 3 * mu * mu * u * seg.c0.z + 3 * mu * u * u * seg.c1.z + u * u * u * seg.p1.z,
  );
}

/**
 * TẠO HÌNH ĐẬU (perch) — toàn bộ thân rồng khi đã đáp, tính theo offset so
 * với mép TRÊN của khối chữ CHÚC MỪNG.
 *
 * Vì sao cần một tạo hình viết tay thay vì để chuỗi khớp tự sắp thân: khi
 * đầu dừng, thân do đầu kéo sẽ nằm lại theo đúng vệt đường bay — nghĩa là
 * một cái cổ đổ dốc từ trên cao xuống, không phải một con rồng ngồi vững
 * trên chữ. Đây là khoảnh khắc GATE C phải đứng: có trọng lượng, có tiếp
 * xúc thật. Nên từ nhịp đáp, thân được trộn dần sang đường cong dựng sẵn.
 *
 * TỶ LỆ: các số liệu dưới đây là toạ độ thế giới, neo vào mép trên khối chữ,
 * và được chuẩn hoá về ĐÚNG chiều dài thân rồng — nên tư thế giữ nguyên kích
 * thước thật ở mọi khổ màn hình. Thứ co giãn theo chữ là tầm với của bốn bàn
 * chân (stage.ts tự cân `stance` theo khoảng cách hông→mặt chữ), không phải
 * thân mình.
 *
 * Thế đậu là một hình S MỞ chứ không phải cuộn tròn: đầu cao hơn mặt chữ ba
 * bậc và vươn về phía ống kính, cổ đổ xuống ngực nơi hai chân trước bám mép
 * chữ, mình xuôi sang phải và hạ dần vào hai chân sau, nửa sau thân mới vòng
 * lên cao rồi buông đuôi về phía SAU khối chữ. Vòng mở để đầu không bị thân
 * che mất — nếu cuộn kín, khoảnh khắc chiến thắng chỉ còn một đống vàng.
 */
const PERCH_SHAPE: [number, number, number][] = [
  [0, 3.05, 2.05], //    đầu ngẩng cao, tiến về phía người xem
  [0.15, 2.05, 1.35], // cổ dưới hàm
  [0.55, 1.2, 0.7], //   ngực — hai chân trước chống (đốt 7)
  [2.15, 1.05, 0.15], // mình xuôi dần sang phải, sát mặt chữ
  [3.7, 0.95, -0.75], // hông sau — hai chân sau (đốt 17)
  [5.0, 2.2, -2.2], //   vòng lưng lên cao phía sau chữ
  [4.5, 3.6, -3.3], //   đuôi vươn lên nhịp khoe chiến thắng
  [2.3, 4.4, -3.5], //   đỉnh vòng cung trên khối chữ
  [-0.2, 4.0, -2.6], //  lưng vòng sang trái
  [-2.0, 2.8, -1.1], //  chóp đuôi buông xuống sau khối chữ
];

/** Biên độ ngẩng mình khi tích lửa, theo đơn vị chữ. */
const REAR_Y = 0.72;
const REAR_Z = 0.5;
const PERCH_BLEND_IN = 0.55;
/**
 * Đơn vị chữ tham chiếu: ở màn hình desktop chuẩn, nửa cao độ chữ xấp xỉ
 * 0.85 thế giới. Mọi số liệu tầm với của chân đã kiểm chứng ở đơn vị này,
 * nên khi chữ to/nhỏ hơn, cẳng bàn chân phải co giãn theo tỷ lệ bodyScale.
 */
const REFERENCE_UNIT = 0.85;

export const TIMELINE = {
  duration: 10,
  /** Chữ CHÚC MỪNG xuất hiện (giây) — rồng đáp lên ngay sau đó. */
  titleAt: 4.75,
  /** Bảng thông tin xe + lời chúc (giây). */
  bannerAt: 6.9,
  /** Moment móng chạm mặt chữ — dùng để đồng bộ rung chữ + particle va chạm. */
  contactAt: 6.18,
  /** Phun lửa. */
  fireStart: 7.15,
  fireEnd: 8.55,
} as const;

export class Choreographer {
  /**
   * Neo sân khấu: điểm thế giới ngay giữa mép trên của khối chữ, do overlay
   * chiếu từ DOM thật mỗi khung hình. Mọi thứ cảnh 4-6 dựa vào đó nên rồng
   * đậu đúng chữ ở mọi khổ màn hình, mọi hướng xoay.
   */
  readonly anchor = new Vector3(0, 0.15, 0);
  /**
   * Tỷ lệ rồng so với chữ thật. 1 = đúng bằng các số liệu đã biên tập ở
   * REFERENCE_UNIT; máy quay/DOM quyết định con số này mỗi khung hình.
   */
  bodyScale = 1;
  private bodyLength = 17.1;
  private stageUnit = 0;
  /**
   * Hệ số co thật của tư thế đậu = unit × k. Đây là con số BẤT BIẾN với khổ
   * màn hình (đường cong đậu luôn được chuẩn hoá về đúng chiều dài thân),
   * nên nhịp ngẩng mình và nhịp thở phải nhân theo nó chứ không nhân theo
   * `stageUnit`: nhân theo stageUnit thì desktop ngẩng cao gấp 1.6 lần
   * mobile — cùng một đòn diễn mà hai kết quả khác nhau.
   */
  private perchScale = 0.9;
  private perch: CatmullRomCurve3 | null = null;
  private readonly perchTmp = new Vector3();

  /** Nạp chiều dài thân thật (số khớp × khoảng cách đốt) để hiệu chỉnh tỷ lệ. */
  setBodyLength(length: number) {
    if (Math.abs(this.bodyLength - length) < 1e-6) return;
    this.bodyLength = length;
    this.stageUnit = -1; // buộc dựng lại đường cong đậu
  }

  /**
   * Chọn tỷ lệ sân khấu theo cao độ chữ THẬT đang hiển thị, trong giới hạn
   * để rồng không bao giờ thành con giun (chữ quá to) hay con rắn (chữ quá
   * nhỏ). Đường cong đậu được dựng lại rồi chuẩn hoá về đúng chiều dài
   * thân, nên các đốt luôn cách nhau đều dù tỷ lệ đổi.
   */
  setStage(titleHeightWorld: number) {
    const unit = Math.min(1.15, Math.max(0.72, titleHeightWorld * 0.5));
    if (Math.abs(unit - this.stageUnit) < 0.01 && this.perch) return;
    this.stageUnit = unit;
    this.bodyScale = unit / REFERENCE_UNIT;
    const shape = PERCH_SHAPE.map(
      ([x, y, z]) => new Vector3(x * unit, y * unit, z * unit),
    );
    const raw = new CatmullRomCurve3(shape, false, "catmullrom", 0.5);
    const k = this.bodyLength / Math.max(1e-6, raw.getLength());
    this.perchScale = unit * k;
    this.perch = new CatmullRomCurve3(
      shape.map((p) => p.multiplyScalar(k)),
      false,
      "catmullrom",
      0.5,
    );
  }

  /** 0 = thân do chuỗi khớp tự sắp đặt (đang bay) … 1 = đúng tạo hình đậu. */
  perchBlend(t: number): number {
    return easeInOutCubic(window01(t, TIMELINE.contactAt - PERCH_BLEND_IN, TIMELINE.contactAt + 0.45));
  }

  /** Nhịp ngẩng mình khi tích lửa: dồn ở cổ và ngực, đuôi gần như bất động. */
  rearAmount(t: number): number {
    const lift = easeOutCubic(window01(t, TIMELINE.fireStart - 0.25, TIMELINE.fireStart + 0.5));
    const settle = 1 - 0.35 * window01(t, 8.9, 9.6);
    return lift * settle;
  }

  /**
   * Trộn vị trí các đốt thân sang tạo hình đậu. `points[i]` là khớp thứ i
   * tính từ đầu; u=0 ở đầu, u=1 ở chóp đuôi. Toàn bộ toạ độ neo vào
   * `anchor` (mép trên khối chữ) nên đây là lúc rồng "ngồi lên chữ" thật.
   */
  applyPerch(points: Vector3[], blend: number, t: number): void {
    if (!this.perch || blend <= 0) return;
    const n = points.length - 1;
    const rear = this.rearAmount(t) * this.perchScale;
    for (let i = 0; i <= n; i += 1) {
      // getPointAt theo cung đều để các đốt cách nhau đúng một khoảng,
      // không chỗ dãn chỗ nén như getPoint theo tham số.
      const u = i / n;
      this.perch.getPointAt(u, this.perchTmp).add(this.anchor);
      if (rear > 0.001) {
        const w = 1 - Math.min(1, u / 0.45);
        this.perchTmp.y += REAR_Y * rear * w * w;
        this.perchTmp.z += REAR_Z * rear * w * w;
      }
      // Nhân vật phải "sống" cả khi đã đứng yên: một nhịp thở chậm lan
      // dọc thân, biên độ đủ nhỏ để không nhấc móng khỏi mặt chữ.
      this.perchTmp.y += Math.sin(t * 1.75 - u * 2.4) * 0.055 * this.perchScale;
      points[i].lerp(this.perchTmp, blend);
    }
  }

  /** Vị trí đầu rồng tại thời điểm t (giây), cộng hưởng dao động hô hấp. */
  headPosition(t: number, out: Vector3): Vector3 {
    const clamped = Math.min(10, Math.max(0, t));
    let seg = SEGMENTS[SEGMENTS.length - 1];
    for (const s of SEGMENTS) {
      if (clamped <= s.t1) {
        seg = s;
        break;
      }
    }
    const u = seg.ease(clamp01((clamped - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0)));
    bezier(seg, u, out);
    // Cả đường bay lẫn tư thế đậu đều neo vào mép trên khối chữ, nên phép
    // cộng neo là vô điều kiện: đổi viewport là đổi cả sân khấu một lần.
    out.add(this.anchor);
    // Hô hấp + gợn nhỏ khi đã đáp: nhân vật "sống" chứ không đứng chết.
    if (clamped > 6.6) {
      const settle = window01(clamped, 6.6, 7.4);
      out.y += Math.sin(clamped * 1.9) * 0.05 * settle;
      out.x += Math.sin(clamped * 1.3 + 1) * 0.03 * settle;
    }
    return out;
  }

  /**
   * Hướng đầu rồng (quy ước +Z là trục nhìn của nhân vật). Trước cảnh 4 đầu
   * bám theo tiếp tuyến quỹ đạo (trả null); từ khi đáp, đầu ngẩng nhìn về
   * phía người xem — đây là khoảnh khắc bán "thần thái".
   */
  headAim(t: number, headPos: Vector3, out: Quaternion): Quaternion | null {
    if (t < 5.0) return null;
    const target = V.copy(this.aimTarget(t)).add(this.anchor);
    M.lookAt(target, headPos, UP);
    out.setFromRotationMatrix(M);
    const blend = window01(t, 5.0, 6.4);
    if (blend < 1) {
      // Pha trộn dần từ "nhìn theo hướng bay" sang "nhìn thẳng người xem".
      const tan = this.tangent(t, V2);
      M.lookAt(V2.addVectors(headPos, tan), headPos, UP);
      out.slerp(TMP_Q.setFromRotationMatrix(M), 1 - blend);
    }
    return out;
  }

  /**
   * Đường cong mục tiêu nhìn — ba nhịp rời nhau nhưng nối LIÊN TỤC, không
   * cắt đoạn: cúi nhìn mặt chữ khi đáp → xoay chếch sang phải để phun lửa
   * → quay lại thẳng ống kính giữ thế chiến thắng. Đổi mục tiêu bằng một
   * phát nhảy tức là quay đầu đột ngột giữa khung hình, bị coi là lỗi.
   */
  private aimTarget(t: number): Vector3 {
    const toFire = window01(t, 6.85, TIMELINE.fireStart + 0.12);
    const toViewer = window01(t, TIMELINE.fireEnd - 0.15, 9.35);
    return AIM_TMP.copy(AIM_DOWN).lerp(AIM_FIRE, toFire).lerp(AIM_CAMERA, toViewer);
  }

  /** Vector tiếp tuyến quỹ đạo (để nội suy hướng mượt khi bay). */
  tangent(t: number, out: Vector3): Vector3 {
    const h = 0.03;
    const a = this.headPosition(Math.max(0, t - h), new Vector3());
    const b = this.headPosition(Math.min(10, t + h), out);
    return b.sub(a).normalize();
  }

  /** 0..1 độ há hàm dưới. */
  jawOpen(t: number): number {
    if (t < TIMELINE.fireStart - 0.35) return 0.04 + 0.03 * Math.sin(t * 2);
    const charge = window01(t, TIMELINE.fireStart - 0.35, TIMELINE.fireStart);
    const hold = 1 - window01(t, TIMELINE.fireEnd, TIMELINE.fireEnd + 0.75);
    return Math.min(1, charge * 1.15) * hold * 0.96 + 0.04;
  }

  /** Sáng họng: tích lửa trước khi phun, tắt dần khi hết. */
  throatGlow(t: number): number {
    const charge = window01(t, 6.95, TIMELINE.fireStart);
    const fade = 1 - window01(t, TIMELINE.fireEnd - 0.1, TIMELINE.fireEnd + 0.5);
    return charge * fade;
  }

  /** Cường độ luồng lửa. */
  fireIntensity(t: number): number {
    if (t < TIMELINE.fireStart || t > TIMELINE.fireEnd) return 0;
    const ramp = window01(t, TIMELINE.fireStart, TIMELINE.fireStart + 0.28);
    const tail = 1 - window01(t, TIMELINE.fireEnd - 0.42, TIMELINE.fireEnd);
    return Math.pow(ramp, 0.6) * Math.pow(tail, 0.8);
  }

  /** Chân trước với xuống mặt chữ: 0 = co khi bay, 1 = chống hết lực. */
  legReach(t: number): number {
    return easeOutCubic(window01(t, 5.35, TIMELINE.contactAt + 0.15));
  }

  /** Biên độ sóng thân: bay hết cỡ, dịu dần khi đã đáp (thân ổn định). */
  swim(t: number): number {
    return 1 - 0.62 * window01(t, 5.6, 7.2);
  }

  /** Vị trí + FOV + rung máy quay. */
  camera(t: number, out: Vector3): { fov: number; shake: number } {
    // Push-in nhẹ đầu cảnh 1 để tăng cảm giác khổng lồ, rồi giữ vững.
    const push = 1 - easeOutCubic(window01(t, 0, 2.4));
    out.set(Math.sin(t * 0.31) * 0.22, 0.35 - Math.cos(t * 0.24) * 0.18, 16.6 - push * 1.5);
    // Rung máy quay: một nhịp nảy khi móng chạm chữ, một nhịp khi lửa bùng.
    const impact = Math.max(
      Math.exp(-Math.pow((t - TIMELINE.contactAt) * 7, 2)) * 0.26,
      Math.exp(-Math.pow((t - (TIMELINE.fireStart + 0.1)) * 6, 2)) * 0.16,
    );
    return { fov: 48 + push * 3.2, shake: impact };
  }

  /** Rồng có đang ở tạo hình "đáp trên chữ" không (để neo chân thế giới). */
  isSettled(t: number): boolean {
    return t >= TIMELINE.contactAt - 0.1;
  }
}
