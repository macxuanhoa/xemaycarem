// Lửa phun về phía người xem: không phải một tấm PNG hình tam giác.
//
// Mỗi khung hình phát liên tục một lớp hạt từ đúng khóe miệng (điểm attach
// đi theo matrixWorld của đầu rồng), vận tốc theo hướng đầu đang nhìn với
// tán hình nón, khối lượng ba lớp:
//   1) lõi trắng-kim nhỏ – nhanh – thẳng  → cảm giác "nhiệt độ cao"
//   2) thân lửa to dần, nhiễu loạn xoáy   → thể tích và chiều sâu
//   3) tàn lửa tia nhỏ bay xiên, chậm hơn → chi tiết chuyển động phụ
// Shader tự nguội màu theo vòng đời (trắng -> cam -> đỏ sẫm -> khói), nên
// luồng lửa có đầu sáng cuối tối đúng vật lý. Một PointLight nhấp nháy tại
// miệng đổ sáng lên chính hàm răng và vảy cổ — long đèn là thật, không vẽ.

import { PointLight, Vector3 } from "three";

import { Particles, rand } from "./particles";

const HOT = new Vector3(1.0, 0.72, 0.36);
const EMBER = new Vector3(1.0, 0.36, 0.06);

export class Flame {
  readonly fire: Particles;
  readonly sparks: Particles;
  readonly light: PointLight;
  private readonly dir = new Vector3();
  private readonly vel = new Vector3();
  private readonly jitter = new Vector3();
  private readonly origin = new Vector3();
  private readonly emberColor = new Vector3();
  private readonly phase = new Float32Array(4096);
  /**
   * Nấc thấp tắt bloom để giữ khung hình trên điện thoại, nhưng bloom chính
   * là thứ dệt chồng hạt rời thành KHỐI. Không có nó, cùng một số hạt chỉ
   * còn là một chùm đốm. Bù lại bằng hình học: sprite to hơn và ít hơn
   * (theo căn bậc hai để tổng diện tích phủ không đổi) — cùng một thể tích
   * lửa với cùng một hạn ngạch fill-rate.
   */
  private readonly sizeScale: number;
  private readonly emitScale: number;

  constructor(quality: { fire: number; sparks: number; sizeScale?: number }) {
    this.sizeScale = quality.sizeScale ?? 1;
    this.emitScale = 1 / Math.sqrt(this.sizeScale);
    this.fire = new Particles(quality.fire);
    this.sparks = new Particles(quality.sparks);
    this.fire.points.renderOrder = 6;
    this.sparks.points.renderOrder = 7;
    this.light = new PointLight(0xff8a2e, 0, 10, 2);
    // Nhiễu loạn xoáy: mỗi hạt nhận gia tốc hướng tâm + dọc theo pha riêng,
    // tạo bề mặt lửa gợn liên tục thay vì một cái nón đều tẻ.
    this.fire.onForce = (i, vel, _pos, life, maxLife) => {
      const p = this.phase[i] ?? (this.phase[i] = rand(0, Math.PI * 2));
      const t = life / maxLife;
      const swirl = 1.9 * (1 - t);
      vel[i * 3] += Math.sin(p + life * 11) * swirl * 0.016;
      vel[i * 3 + 1] += Math.cos(p * 1.7 + life * 9.3) * swirl * 0.016 + 1.1 * 0.016;
      vel[i * 3 + 2] += Math.sin(p * 2.3 + life * 7.7) * swirl * 0.016;
    };
  }

  /**
   * @param origin điểm giữa miệng (world)
   * @param direction hướng đầu đang nhìn (world, đã chuẩn hóa)
   * @param intensity 0..1 — đường cong bùng nổ/nhả của cú phun
   * @param dt giây
   * @param time giây tổng
   */
  emit(origin: Vector3, direction: Vector3, intensity: number, dt: number, time: number) {
    this.dir.copy(direction);
    const budget = Math.round(intensity * dt * 520 * this.emitScale);
    for (let i = 0; i < budget; i += 1) {
      const spread = 0.13;
      // Tán hình nón quanh hướng đầu; cấp phát lại mỗi hạt sẽ làm GC giật
      // ở 60fps nên mọi vector trung gian đều là tạm dùng chung.
      // Phát lửa dọc một ĐOẠN NGẮN phía trước miệng chứ không từ một ĐIỂM:
      // vài trăm hạt sinh ra trùng đúng một toạ độ sẽ chồng thành một quả
      // cầu trắng loá ngay tại hàm — trong khi miệng lửa thật là một cột
      // có tiết diện, cháy đặc ngay khi vừa lọt ra khỏi kẽ răng.
      this.jitter.set(rand(-spread, spread), rand(-spread, spread), rand(-spread, spread));
      this.origin.copy(origin).addScaledVector(this.dir, rand(0, 0.45)).add(this.jitter);
      this.vel
        .copy(this.dir)
        .add(this.jitter)
        .normalize()
        .multiplyScalar(rand(8, 12) * (0.75 + intensity * 0.3));
      const core = Math.random() < 0.22;
      this.fire.spawn({
        position: this.origin,
        velocity: this.vel,
        color: core ? HOT : EMBER,
        // Hạt lửa PHẢI to và mờ chồng lên nhau thì mới ra KHỐI lửa. Hạt
        // nhỏ 6–12 pixel dù dày đặc vẫn đọc thành một chùm đốm rời rạc như
        // pháo tép, không phải luồng lửa. Bù lại phải giảm số hạt để thể
        // tích lớn không cộng màu quá tay thành một mảng trắng.
        size: (core ? rand(0.08, 0.16) : rand(0.22, 0.44)) * this.sizeScale,
        life: core ? rand(0.2, 0.34) : rand(0.35, 0.62),
        gravity: 0.5,
        // Lực cản quyết định hình hài luồng lửa. 0.9 mỗi khung hình nghĩa là
        // sau 0.15 giây hạt còn 30% vận tốc — toàn bộ năng lượng dồn sạch
        // trong một quả cầu ngay tại hàm, đúng cái lỗi đã làm cú phun thành
        // một đốm sáng thay vì một lưỡi lửa. 0.975 cho tia lửa bay được ~3
        // đơn vị rồi mới tàn: đặc ở gốc, loe và nguội dần ở ngọn.
        drag: 0.975,
        kind: 1,
      });
    }
    // Tàn lửa: tia nhỏ, bay xa hơn, rơi chậm — đọc là "vật chất" chứ không
    // phải sương mù màu cam.
    const emberBudget = Math.round(intensity * dt * 260 * this.emitScale);
    for (let i = 0; i < emberBudget; i += 1) {
      this.jitter.set(rand(-0.35, 0.35), rand(-0.15, 0.5), rand(-0.35, 0.35));
      this.origin.copy(origin).addScaledVector(this.dir, rand(0, 0.4));
      this.vel
        .copy(this.dir)
        .add(this.jitter)
        .normalize()
        .multiplyScalar(rand(7, 12));
      // Shader nâng màu hạt pháo (kind 0) về phía trắng để tia pháo trông
      // như tia lửa hàn. Tàn lửa đi chung kind đó nên phải chủ động đặt màu
      // THẲM tay: để (1, 0.8, 0.5) thì đầu luồng lửa thành khói trắng.
      this.emberColor.set(rand(0.8, 0.95), rand(0.34, 0.6), rand(0.05, 0.2));
      this.sparks.spawn({
        position: this.origin,
        velocity: this.vel,
        color: this.emberColor,
        size: rand(0.03, 0.06) * this.sizeScale,
        life: rand(0.5, 1.0),
        gravity: -1.6,
        drag: 0.975,
      });
    }
    // Đèn miệng lửa: nhấp nháy theo hai tần số bất đồng bộ -> không đều,
    // giống hệt hồ quang thật. Tầm sáng ngắn + falloff vật lý (decay 2):
    // đèn chỉ nhuốm hàm và vảy cổ, không được vươn lên cả vòm trời rồi
    // rửa hồng một nửa khung hình. Nhìn bằng ảnh mới thấy: đèn xa là kẻ
    // thù của tương phản.
    this.light.position.copy(origin).addScaledVector(this.dir, 0.5);
    const flicker = 0.72 + 0.28 * Math.sin(time * 37.1) * Math.cos(time * 21.7);
    this.light.intensity = intensity * flicker * 30;
  }

  /** Khi không phun: tắt đèn, để hạt tự tàn theo vòng đời. */
  idle() {
    this.light.intensity = 0;
  }

  update(dt: number) {
    this.fire.update(dt);
    this.sparks.update(dt);
  }

  dispose() {
    this.fire.dispose();
    this.sparks.dispose();
  }
}
