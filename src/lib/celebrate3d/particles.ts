// Hệ hạt dùng chung cho pháo hoa và lửa phun: một pool BufferGeometry với
// shader điểm tròn mềm, cộng màu (additive) để chồng thành ánh sáng rực như
// thật. Tích phân trên CPU (đơn giản, ổn định, không cần transform feedback)
// nhưng chỉ với thuộc tính — không cấp phát mỗi khung hình, không GC giật.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  Vector3,
} from "three";

// Kích thước hạt tính theo ĐƠN VỊ THẾ GIỚI (đường kính thật), quy đổi sang
// pixel bằng chính phối cảnh của máy quay: px = size * uPointScale / dist.
// Cách cũ (hằng số 320 nhân tay) khiến một hạt pháo to bằng nửa màn hình và
// cộng màu làm trắng cả khung hình — ở đây có trần bán kính điểm để điều đó
// không bao giờ lặp lại.
const VERT = /* glsl */ `
uniform float uPointScale;
uniform float uMaxPointSize;
attribute vec3 aColor;
attribute float aSize;
attribute float aLife;
attribute float aMaxLife;
attribute float aKind;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vRemain;
void main() {
  float remain = clamp(1.0 - aLife / max(aMaxLife, 0.0001), 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Hạt lửa (kind 1) nở nhẹ theo vòng đời để ngọn lửa loe ra. Nở quá tay
  // thì nửa sau luồng lửa thành bồ khói trắng bệch chứ không còn là lửa.
  float grow = mix(1.0, 1.0 + (1.0 - remain) * 0.55, step(0.5, aKind));
  float px = aSize * grow * uPointScale / max(0.05, -mv.z);
  gl_PointSize = clamp(px, 0.0, uMaxPointSize);
  gl_Position = projectionMatrix * mv;
  vColor = aColor;
  vKind = aKind;
  vRemain = remain;
  vAlpha = smoothstep(0.0, 0.12, remain) * pow(remain, mix(0.85, 1.9, step(0.5, aKind)));
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vRemain;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float core = pow(max(0.0, 1.0 - r * 2.0), 2.4);
  // Hạt lửa (kind 1) mềm, loe và tự nguội theo vòng đời: trắng-kim -> cam
  // -> đỏ sẫm -> khói. Không cần texture PNG nào cả. Cộng sáng (additive)
  // mà để mỗi hạt gần bằng 1.0 thì vài trăm hạt chồng nhau sẽ loá trắng cả
  // khung hình — năng lượng mỗi hạt phải khiêm tốn để màu còn đọc được.
  vec3 cooled = mix(vec3(0.06, 0.012, 0.004), vColor, smoothstep(0.0, 0.75, vRemain));
  vec3 hot = mix(cooled, vec3(1.0), core * 0.35 * vRemain);
  vec3 tint = mix(mix(vec3(1.0), vColor, 0.72), hot, vKind);
  float shape = mix(core * (0.35 + 0.65 * core), core * 0.5, vKind);
  gl_FragColor = vec4(tint * (0.34 + 0.72 * core), shape * vAlpha);
}
`;

export type SpawnArgs = {
  position: Vector3;
  velocity: Vector3;
  color: Vector3;
  size: number;
  life: number;
  gravity?: number;
  drag?: number;
  /** 0 = tia pháo sắc; 1 = lửa/khói mềm loe. */
  kind?: number;
};

export class Particles {
  readonly points: Points;
  readonly max: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly kind: Float32Array;
  private readonly vel: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private cursor = 0;
  private live = 0;

  /**
   * Lực phụ theo từng hạt (nhiễu loạn cho lửa phun): mutate trực tiếp
   * `vel`/`pos` tại chỉ số i. Gọi cuối vòng tích phân mỗi khung hình.
   */
  onForce?: (i: number, vel: Float32Array, pos: Float32Array, life: number, maxLife: number) => void;

  constructor(max: number) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.kind = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max).fill(0.98);
    // Đẩy mọi hạt ra khỏi tầm nhìn trước khi được spawn.
    for (let i = 0; i < max; i += 1) this.pos[i * 3 + 2] = -9999;

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(this.pos, 3));
    geo.setAttribute("aColor", new BufferAttribute(this.col, 3));
    geo.setAttribute("aSize", new BufferAttribute(this.size, 1));
    geo.setAttribute("aLife", new BufferAttribute(this.life, 1));
    geo.setAttribute("aMaxLife", new BufferAttribute(this.maxLife, 1));
    geo.setAttribute("aKind", new BufferAttribute(this.kind, 1));
    geo.setDrawRange(0, max);
    const material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPointScale: { value: 900 },
        uMaxPointSize: { value: 90 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(geo, material);
    this.points.frustumCulled = false;
  }

  /**
   * Đồng bộ tỷ lệ điểm với máy quay hiện tại.
   * @param pointScale số pixel cho một đơn vị thế giới ở khoảng cách 1
   *                   (= height / (2·tan(fov/2)), tính theo drawing buffer)
   * @param maxPointSize trần bán kính một hạt, tính bằng pixel thiết bị.
   */
  setPointScale(pointScale: number, maxPointSize = 90) {
    const u = (this.points.material as ShaderMaterial).uniforms;
    u.uPointScale.value = pointScale;
    u.uMaxPointSize.value = maxPointSize;
  }

  spawn(p: SpawnArgs) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = p.position.x;
    this.pos[i3 + 1] = p.position.y;
    this.pos[i3 + 2] = p.position.z;
    this.vel[i3] = p.velocity.x;
    this.vel[i3 + 1] = p.velocity.y;
    this.vel[i3 + 2] = p.velocity.z;
    this.col[i3] = p.color.x;
    this.col[i3 + 1] = p.color.y;
    this.col[i3 + 2] = p.color.z;
    this.size[i] = p.size;
    this.life[i] = 0;
    this.maxLife[i] = p.life;
    this.grav[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0.985;
    this.kind[i] = p.kind ?? 0;
    this.live = Math.min(this.live + 1, this.max);
  }

  /** Tích phân một bước; trả số hạt còn sống (để QA đo tải thực). */
  update(dt: number): number {
    let alive = 0;
    for (let i = 0; i < this.max; i += 1) {
      if (this.life[i] >= this.maxLife[i]) continue;
      this.life[i] += dt;
      const i3 = i * 3;
      const damp = Math.pow(this.drag[i], dt * 60);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp + this.grav[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.onForce) this.onForce(i, this.vel, this.pos, this.life[i], this.maxLife[i]);
      if (this.life[i] < this.maxLife[i]) alive += 1;
    }
    // Số hạt đang thực sự sống sau bước tích phân — `liveCount` phải là con
    // số thật để báo cáo hiệu năng, không phải đỉnh lịch sử của pool.
    this.live = alive;
    const geo = this.points.geometry;
    (geo.getAttribute("position") as Float32BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aLife") as Float32BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aColor") as Float32BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aSize") as Float32BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aMaxLife") as Float32BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aKind") as Float32BufferAttribute).needsUpdate = true;
    return alive;
  }

  get liveCount() {
    return this.live;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as ShaderMaterial).dispose();
  }
}

/** Màu hex → Vector3 tuyến tính gần đúng cho shader cộng màu. */
export function rgb(hex: number): Vector3 {
  return new Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}

export const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Điểm ngẫu nhiên trên mặt cầu đơn vị. */
export function sphereDir(out: Vector3): Vector3 {
  const z = rand(-1, 1);
  const a = rand(0, Math.PI * 2);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(r * Math.cos(a), r * Math.sin(a), z);
}
