// Pháo hoa 3D có chiều sâu: đạn bay lên để lại quỹ đạo, nổ thành nhiều
// kiểu (peony, ring, palm rũ, crackle secondary, stroke nhũ), mỗi quả là
// một khối cầu hạt thật trong không gian — nổ phía SAU rồng nên khi rồng
// bay qua, tia lửa cắt lớp parallax chứ không dán lên mặt màn hình.
// Kèm theo đó là một đèn flash ngắn cho mỗi quả lớn: ánh sáng nổ phải ĐÁ
// vào vảy vàng của rồng thì mới ra chất điện ảnh.

import { PointLight, Vector3 } from "three";

import { Particles, rand, rgb, sphereDir } from "./particles";

const SHELL_COLORS = [0xffd166, 0xff6b35, 0xfff3b0, 0xff4d6d, 0x8ecae6, 0xffd700, 0xfb8500];

type Shell = {
  pos: Vector3;
  vel: Vector3;
  fuse: number;
  color: number;
  big: boolean;
};

export class Fireworks {
  readonly particles: Particles;
  private readonly shells: Shell[] = [];
  private readonly tmp = new Vector3();
  private readonly burst = new Vector3();
  private readonly flash: PointLight;
  private readonly flashIntensityScale: number;
  private flashDecay = 0;
  private nextShellAt = 0;

  constructor(max: number, flashIntensityScale = 1) {
    this.particles = new Particles(max);
    this.flash = new PointLight(0xffd9a0, 0, 40, 1.6);
    this.flash.position.set(0, 4, -6);
    this.flashIntensityScale = flashIntensityScale;
  }

  get light(): PointLight {
    return this.flash;
  }

  /** Lịch bắn: giây -> số quả, biên độ "big". */
  schedule(t: number, count: number, big: boolean) {
    for (let i = 0; i < count; i += 1) {
      // Điểm phóng chủ đích: hai bên và phía trên khối chữ, nổ ở vùng trời
      // trong khung hình. Phóng từ đáy màn hình rồi bay 9 giây thì pháo nổ
      // tít ngoài rìa, người xem chỉ thấy vài chấm sáng lơ thơ.
      this.shells.push({
        pos: new Vector3(rand(-8.5, 8.5), rand(-1, 3.4), rand(-15, -5)),
        vel: new Vector3(rand(-0.5, 0.5), rand(4, 7), rand(-0.3, 0.3)),
        fuse: t + rand(0.55, 1),
        color: SHELL_COLORS[Math.floor(Math.random() * SHELL_COLORS.length)],
        big,
      });
    }
  }

  /** Nổ tức thì tại một điểm thế giới (dùng cho finale và nhịp đáp đất). */
  explode(at: Vector3, big: boolean) {
    const color = rgb(SHELL_COLORS[Math.floor(Math.random() * SHELL_COLORS.length)]);
    const count = Math.round((big ? 150 : 70) * this.particles.max / 3000);
    const speed = big ? rand(4.5, 6.5) : rand(2.8, 4.2);
    const style = Math.random();
    for (let i = 0; i < count; i += 1) {
      const dir = sphereDir(this.tmp);
      // Palm: ưu tiên hướng lên rồi rũ; ring: dẹt theo mặt phẳng ngẫu nhiên.
      if (style < 0.22) dir.y = Math.abs(dir.y) * 0.9 + 0.25;
      if (style >= 0.22 && style < 0.4) dir.y *= 0.18;
      const v = speed * (0.55 + Math.random() * 0.6);
      // Hạt nhân nổ là một QUẢ CẦU, không phải một điểm: nếu trăm hạt cùng
      // sinh ra tại một chỗ thì khung hình đầu tiên là một đốm trắng cộng
      // dồn sáng — thủng một lỗ trên màn hình đúng lúc quan trọng nhất.
      this.particles.spawn({
        position: this.burst.copy(dir).multiplyScalar(rand(0.05, 0.42)).add(at),
        velocity: this.tmp.copy(dir).multiplyScalar(v),
        color,
        size: rand(0.055, 0.115),
        life: rand(1.1, 2.1),
        gravity: -3.4,
        drag: 0.955,
      });
    }
    // Nhũ lấp lánh chậm hơn, rơi lâu hơn.
    const glitter = Math.round(count * 0.35);
    for (let i = 0; i < glitter; i += 1) {
      const dir = sphereDir(this.tmp);
      this.particles.spawn({
        position: this.burst.copy(dir).multiplyScalar(rand(0.05, 0.3)).add(at),
        velocity: this.tmp.copy(dir).multiplyScalar(speed * rand(0.15, 0.5)),
        color: rgb(0xfff1c2),
        size: rand(0.035, 0.065),
        life: rand(1.8, 3.2),
        gravity: -1.1,
        drag: 0.985,
      });
    }
    this.flash.position.copy(at);
    this.flashDecay = big ? 1 : 0.55;
  }

  update(dt: number, time: number) {
    // Đạn bay + rắc tia lửa quỹ đạo.
    for (let i = this.shells.length - 1; i >= 0; i -= 1) {
      const s = this.shells[i];
      if (time >= s.fuse) {
        this.explode(s.pos, s.big);
        this.shells.splice(i, 1);
        continue;
      }
      // Đạn chỉ bay một giây cuối trước ngòi nổ: tích hợp suốt 9 giây thì
      // quả finale đã bay mất hút khỏi khung hình trước khi kịp nổ.
      if (time < s.fuse - 1) continue;
      s.vel.y -= 3.2 * dt;
      s.pos.addScaledVector(s.vel, dt);
      if (Math.random() < 0.7) {
        this.particles.spawn({
          position: s.pos,
          velocity: this.tmp.set(rand(-0.4, 0.4), rand(-1.4, -0.4), rand(-0.3, 0.3)),
          color: rgb(0xffcf7a),
          size: rand(0.04, 0.075),
          life: rand(0.24, 0.5),
          gravity: -0.6,
          drag: 0.9,
        });
      }
    }
    // Flash lan toả rồi tắt nhanh — không nhấp nháy liên tục (an toàn
    // động học, tôn trọng nhạy cảm ánh sáng).
    if (this.flashDecay > 0) {
      this.flashDecay = Math.max(0, this.flashDecay - dt * 2.6);
      this.flash.intensity = this.flashDecay * this.flashDecay * 160 * this.flashIntensityScale;
    } else {
      this.flash.intensity = 0;
    }
    this.particles.update(dt);
  }

  /** Pháo nền tự động khi không có biên đạo (giữa cảnh). */
  ambient(dt: number, time: number) {
    if (time >= this.nextShellAt) {
      this.nextShellAt = time + rand(0.7, 1.5);
      this.schedule(time, 1, Math.random() < 0.4);
    }
    void dt;
  }

  dispose() {
    this.particles.dispose();
  }
}
