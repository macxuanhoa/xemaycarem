// Lớp DOM của cảnh điện ảnh: chữ CHÚC MỪNG khổng lồ + biểu ngữ thông tin
// xe. Điểm mấu chốt kỹ thuật: rồng KHÔNG đáp vào toạ độ tự đặt, mà đáp vào
// đúng mặt chữ THẬT trên màn hình. Tọa độ DOM của chữ được chiếu ngược qua
// camera (unproject + giao điểm mặt phẳng) thành điểm thế giới, nên dù
// người dùng xoay màn hình, đổi viewport hay nhà thiết kế chỉnh CSS, móng
// vuốt vẫn bám sát mặt chữ — không bao giờ "bay lơ lửng trên chữ".

import { Camera, Plane, Ray, Vector3 } from "three";

const HEADLINES = [
  "Chúc mừng bán xe! 🎉",
  "Xe đã sang tay, tiền về kịp! 🎉",
  "Bán được rồi – Cà Rem hân hoan! 🎉",
  "Thêm một xe lên đường! 🎉",
  "Chốt đơn ngọt ngào! 🎉",
];

const PLANE = new Plane(new Vector3(0, 0, 1), 0);
const RAY = new Ray();
const NDC = new Vector3();
const BOX_TL = new Vector3();
const BOX_BR = new Vector3();
const BOX_RECT = { topY: 0, bottomY: 0, leftX: 0, rightX: 0, height: 1.6 };

export class CelebrationOverlay {
  readonly root = document.createElement("div");
  private readonly title: HTMLElement;
  private readonly plaque: HTMLElement;
  private readonly hint: HTMLElement;
  private banner: HTMLElement | null = null;

  constructor() {
    this.root.className = "sale-celebrate dragon3d";
    this.root.setAttribute("role", "presentation");

    const frame = document.createElement("div");
    frame.className = "sale-celebrate-frame";
    frame.setAttribute("aria-hidden", "true");

    this.title = document.createElement("div");
    this.title.className = "dragon3d-title";
    this.title.textContent = "CHÚC MỪNG";
    this.title.setAttribute("aria-hidden", "true");

    this.plaque = document.createElement("div");
    this.plaque.className = "dragon3d-plaque";
    this.plaque.setAttribute("aria-hidden", "true");

    this.hint = document.createElement("div");
    this.hint.className = "sale-celebrate-hint";
    this.hint.setAttribute("aria-hidden", "true");
    this.hint.textContent = "✦ Bấm vào màn hình để kết thúc sớm ✦";

    this.root.append(frame, this.title, this.plaque, this.hint);
  }

  /** Chữ hiện ra trước khi rồng đáp (giữ đúng nhịp biên đạo). */
  revealTitle() {
    this.title.classList.add("in");
  }

  /** Phản ứng của chữ khi móng chạm mặt: nảy + loé vàng một nhịp. */
  impact() {
    this.title.classList.add("impact");
    window.setTimeout(() => this.title.classList.remove("impact"), 620);
  }

  /** Biển đồng: lời chúc + thông tin xe thật, chữ do trình duyệt render. */
  revealBanner(detail?: string) {
    if (this.banner) return;
    const banner = document.createElement("div");
    banner.className = "sale-celebrate-banner dragon3d-banner";
    const ribbon = document.createElement("em");
    ribbon.className = "sale-celebrate-ribbon";
    ribbon.textContent = "✦ CÀ REM XIN CHÚC MỪNG ✦";
    const line = document.createElement("strong");
    line.textContent = HEADLINES[Math.floor(Math.random() * HEADLINES.length)];
    const sub = document.createElement("span");
    sub.textContent = detail ?? "Thu thuận mua vừa – khách vui, mình vui.";
    banner.append(ribbon, line, sub);
    this.root.appendChild(banner);
    this.banner = banner;
    this.plaque.classList.add("in");
  }

  /**
   * Chiếu một điểm CSS (px tính theo phần tử root) ra vị trí thế giới trên
   * mặt phẳng sân khấu z=0.
   */
  worldPoint(cssX: number, cssY: number, camera: Camera, out: Vector3): Vector3 {
    const rect = this.root.getBoundingClientRect();
    NDC.set(
      ((cssX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -(((cssY - rect.top) / Math.max(1, rect.height)) * 2 - 1),
      0.5,
    );
    RAY.origin.copy(camera.position);
    RAY.direction.copy(NDC).unproject(camera).sub(camera.position).normalize();
    if (!RAY.intersectPlane(PLANE, out)) out.set(0, 0, 0);
    return out;
  }

  /**
   * Khối chữ trong toạ độ thế giới trên mặt phẳng sân khấu (z=0). Đây là
   * cầu nối duy nhất giữa layout CSS và 3D: đổi font, đổi viewport, xoay
   * màn hình đều tự động kéo sân khấu đi theo.
   *
   * Dùng TÂM của hộp đã biến hình + KÍCH THƯỚC layout: chữ được canh giữa
   * bằng transform: translate(-50%,-50%) scale(0.72 → 1), mà phép biến hình
   * đó lấy chính tâm làm gốc nên tâm không đổi — chỉ có bề rộng/cao là đổi
   * theo scale. Đọc rect thì mặt chữ "chạy" theo hoạt hình reveal và cả nhân
   * vật bị tụt/trượt theo; đọc offsetLeft/Top đơn thuần thì lại quên mất
   * translate(-50%,-50%), neo lệch sang phải nguyên nửa bề ngang khối chữ.
   * Ghép cả hai mới ra vị trí CUỐI CÙNG của chữ — thứ mà móng vuốt phải bám.
   */
  titleBox(
    camera: Camera,
    out: { topY: number; bottomY: number; leftX: number; rightX: number; height: number },
  ) {
    const el = this.title;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const halfW = el.offsetWidth / 2;
    const halfH = el.offsetHeight / 2;
    const tl = this.worldPoint(cx - halfW, cy - halfH, camera, BOX_TL);
    const br = this.worldPoint(cx + halfW, cy + halfH, camera, BOX_BR);
    out.topY = Math.max(tl.y, br.y);
    out.bottomY = Math.min(tl.y, br.y);
    out.leftX = Math.min(tl.x, br.x);
    out.rightX = Math.max(tl.x, br.x);
    // Cao độ chữ quyết định tỷ lệ nhân vật: rồng cao ~2 lần chữ, không bao
    // giờ là con giun bò trên tấm biển khổng lồ.
    out.height = Math.max(0.2, out.topY - out.bottomY);
    return out;
  }

  /**
   * Neo sân khấu cho biên đạo: điểm thế giới ngay giữa mép trên của khối
   * chữ, kèm cao độ chữ. Rồng đậu LÊN chữ nên chính chữ quyết định cả sàn
   * diễn lẫn kích thước nhân vật.
   */
  titleAnchor(camera: Camera, out: Vector3): { topY: number; height: number } {
    const box = this.titleBox(camera, BOX_RECT);
    out.set((box.leftX + box.rightX) / 2, box.topY, 0);
    return box;
  }

  /**
   * Điểm đặt bốn bàn chân: mỗi chân tìm điểm trên mặt chữ NGAY DƯỚI HÔNG
   * của chính nó, mở rộng ra ngoài một chút cho thế đứng vững chãi.
   *
   * Tuyệt đối không ghim bốn móng vào bốn góc khối chữ: một con rồng dài
   * hơn một chữ cái mà "bám" hết chiều ngang bảng hiệu thì chân duỗi
   * thành cây sào xuyên khung hình — sai giải phẫu và sai cả phối cảnh.
   * Bù lại, chân nào hông nấy luôn trong tầm với, ở mọi khổ màn hình.
   */
  clawTargets(
    camera: Camera,
    hips: Vector3[],
    out: (Vector3 | null)[],
  ): (Vector3 | null)[] {
    const box = this.titleBox(camera, BOX_RECT);
    for (let i = 0; i < out.length; i += 1) {
      const hip = hips[i];
      if (!hip) {
        out[i] = null;
        continue;
      }
      const t = out[i] ?? new Vector3();
      // Thứ tự chân giống dragon.ts: trái trước, phải trước, trái sau, phải sau.
      const side = i % 2 === 0 ? -1 : 1;
      // Sâu hơn mặt chữ một chút thì móng "lọt thỏm" ra sau tấm biển và biến
      // mất sau nét chữ; kẹp trong dải hẹp ngay TRƯỚC mặt phẳng sân khấu để
      // cả bốn bàn chân đều nhìn thấy được thế đang bám chữ.
      t.set(
        Math.min(box.rightX, Math.max(box.leftX, hip.x + side * 0.45)),
        box.topY + 0.05,
        Math.min(0.5, Math.max(-0.1, hip.z - 0.25)),
      );
      out[i] = t;
    }
    return out;
  }

  /** Nhịp mờ dần trước khi gỡ overlay. */
  beginExit() {
    this.root.classList.add("leaving");
  }

  destroy() {
    this.root.remove();
  }
}
