// Chúc mừng bán xe – đại tiệc điện ảnh 10 giây phủ toàn màn hình: một con
// rồng vàng - ngọc khổng lồ uốn lượn xuyên khung hình (thân dài nhiều màn
// hình, giải phẫu đầu sừng - bờm - râu - mõm, vảy - gai lưng - bụng sáng),
// pháo hoa nhiều tầng (shell bay có quỹ đạo rắc tia lửa, burst nứt hạt
// secondary, nhũ, confetti) và khung nghi lễ vàng hào hùng (letterbox,
// viền chạm góc, biểu ngữ hero chữ ánh kim). Module thuần DOM/canvas, tự
// dọn dẹp, không kéo thêm thư viện. Bấm vào màn hình là kết thúc sớm; tôn
// trọng prefers-reduced-motion; hạt bị cắt trần để máy yếu vẫn mượt.

export type CelebrateOptions = {
  /** Dòng banner phụ trong banner chính, ví dụ biển số hoặc mã xe vừa bán. */
  detail?: string;
};

// Toàn cảnh kéo dài đúng 10 giây trừ khi người dùng bấm tắt sớm.
const LIFETIME_MS = 10000;
const FADE_MS = 600;
const BANNER_MS = 8700;
// Trần số hạt đồng thời – thiết bị yếu vẫn chạy 60fps nhờ cắt từ đầu.
const MAX_PARTICLES = 1150;

// Rồng khổng lồ 3D: đầu chạy quỹ đạo Lissajous nhiều tầng sóng phủ toàn màn
// hình; mình là chuỗi khớp lấy từ lịch sử quỹ đạo, vẽ đuôi trước - đầu sau
// (painter's algorithm). Độ sâu z điều phối kích thước + độ sáng + độ mờ
// nên rồng như lặn vào/ló ra khỏi không gian. Thân dài ~4 giây đường bay
// (vài lần chiều ngang màn hình) với bụng sáng, gai lưng và vảy so le.
const DRAGON_DURATION_MS = 9200;
const DRAGON_SEGMENTS = 64;
const DRAGON_CHAIN_SPACING = 4;
const DRAGON_HISTORY_CAP = 1400;
// Số khung hình "quá khứ" nạp sẵn trước giờ G để rồng vào cảnh đã có
// thân dài đầy đủ thay vì lớn dần từ cụt.
const DRAGON_WARMUP_FRAMES = DRAGON_SEGMENTS * DRAGON_CHAIN_SPACING + 10;

// Bảng màu lễ hội: đủ sáng trên cả nền sáng lẫn dark theme.
const PALETTE = [
  "#f59e0b", "#ef4444", "#22c55e", "#38bdf8", "#a78bfa",
  "#f472b6", "#facc15", "#2dd4bf", "#fb923c", "#e879f9",
];

const CONFETTI_COLORS = ["#4f46e5", "#f59e0b", "#ef4444", "#22c55e", "#38bdf8", "#f472b6", "#fde047"];

// Emoji nhỏ bay lẫn trong pháo – xe máy, cà rem, tiền và lộc may mắn.
const EMOJIS = ["🏍️", "🛵", "🛴", "💰", "✨", "🎉", "🔥", "🍀"];

const HEADLINES = [
  "Chúc mừng bán xe! 🎉",
  "Xe đã sang tay, tiền về kịp! 🎉",
  "Bán được rồi – Cà Rem hân hoan! 🎉",
  "Thêm một xe lên đường! 🎉",
  "Chốt đơn ngọt ngào! 🎉",
];

const SUBLINES = [
  "Thu thuận mua vừa – khách vui, mình vui.",
  "Cà Rem chúc mừng, ra lộc đầu ngày!",
  "Khui lon nước mát, chuẩn bị xe mới!",
  "Lại một khách hàng mang về niềm tin.",
  "Tồn kho vơi, doanh thu đầy!",
];

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  gravity: number;
  drag: number;
  glitter: boolean;
  /** Vẽ dài theo vector vận tốc (quỹ đạo tên lửa / sao băng). */
  trail?: boolean;
  /** Xé thành tia nhỏ khi tàn (hạt secondary của burst nứt). */
  crackle?: boolean;
  emoji?: string;
  rotation?: number;
  spin?: number;
};

/** Một mẫu lịch sử quỹ đạo đầu rồng: x, y màn hình + z độ sâu (-1..1). */
type DragonPoint = { x: number; y: number; z: number };

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Một vòng pháo hoa truyền thống: tia sáng tỏa đều rồi rơi dần. */
function burstClassic(x: number, y: number): Particle[] {
  const color = pick(PALETTE);
  const count = 30 + Math.floor(Math.random() * 16);
  const speed = 2.8 + Math.random() * 2;
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.18;
    const v = speed * (0.65 + Math.random() * 0.55);
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 66 + Math.random() * 30,
      color,
      size: 1.8 + Math.random() * 1.6,
      gravity: 0.045,
      drag: 0.968,
      glitter: Math.random() < 0.3,
      crackle: Math.random() < 0.45,
    };
  });
}

/** Vòng ring tròn đều như bông cúc dẹt, bay chậm và lâu tàn hơn. */
function burstRing(x: number, y: number): Particle[] {
  const color = pick(PALETTE);
  const count = 34;
  const speed = 2.4 + Math.random() * 1.2;
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count;
    return {
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: 74 + Math.random() * 20,
      color,
      size: 2.2,
      gravity: 0.02,
      drag: 0.955,
      glitter: true,
    };
  });
}

/** Cọ vàng: tia bay vọt lên rồi rũ xuống như cành lá. */
function burstPalm(x: number, y: number): Particle[] {
  const color = pick(["#facc15", "#fb923c", "#f59e0b", "#fde047"]);
  const count = 14 + Math.floor(Math.random() * 6);
  return Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.3;
    const v = 4 + Math.random() * 2.4;
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 92 + Math.random() * 26,
      color,
      size: 2.4 + Math.random() * 1.2,
      gravity: 0.075,
      drag: 0.985,
      glitter: false,
      crackle: Math.random() < 0.5,
    };
  });
}

/** Nhũ lấp lánh: chậm, nhỏ, nhấp nháy khi bay. */
function burstGlitter(x: number, y: number): Particle[] {
  const color = pick(PALETTE);
  return Array.from({ length: 24 + Math.floor(Math.random() * 12) }, () => {
    const angle = Math.random() * Math.PI * 2;
    const v = 0.6 + Math.random() * 1.6;
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 85 + Math.random() * 45,
      color,
      size: 1 + Math.random() * 1.6,
      gravity: 0.01,
      drag: 0.975,
      glitter: true,
    };
  });
}

/** Pháo kép: hai màu đồng tâm như hoa cúc lồng. */
function burstDouble(x: number, y: number): Particle[] {
  const outerColor = pick(PALETTE);
  let innerColor = pick(PALETTE);
  if (innerColor === outerColor) innerColor = "#fde047";
  const mk = (count: number, speed: number, color: string, size: number, maxLife: number, i0: number) =>
    Array.from({ length: count }, (_, j) => {
      const angle = (Math.PI * 2 * (j + i0)) / (count + i0) + Math.random() * 0.1;
      return {
        x, y,
        vx: Math.cos(angle) * speed * (0.85 + Math.random() * 0.3),
        vy: Math.sin(angle) * speed * (0.85 + Math.random() * 0.3),
        life: 0,
        maxLife: maxLife + Math.random() * 16,
        color,
        size,
        gravity: 0.03,
        drag: 0.962,
        glitter: Math.random() < 0.4,
      };
    });
  return [...mk(28, 3.4, outerColor, 2.2, 70, 0), ...mk(20, 1.7, innerColor, 1.7, 84, 7)];
}

/** Vệt sáng nổ tại chỗ như chớp nháy (flash burst toàn tia ngắn). */
function burstFlash(x: number, y: number): Particle[] {
  const color = pick(["#fef9c3", "#fde047", "#fbbf24", "#fff7ed"]);
  return Array.from({ length: 22 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const v = 3.4 + Math.random() * 3;
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 24 + Math.random() * 14,
      color,
      size: 1.4 + Math.random(),
      gravity: 0.02,
      drag: 0.9,
      glitter: false,
      trail: true,
    };
  });
}

/** Tên lửa bắn từ mép dưới lên, để lại quỹ đạo sáng, nổ khi hết đạn. */
function makeShell(w: number, h: number): { p: Particle; explodeAt: number } {
  const explodeAt = 48 + Math.random() * 26;
  return {
    explodeAt,
    p: {
      x: w * (0.15 + Math.random() * 0.7),
      y: h + 10,
      vx: (Math.random() - 0.5) * 1.1,
      vy: -(7.6 + Math.random() * 2.6),
      life: 0,
      maxLife: explodeAt,
      color: pick(["#fde047", "#fb923c", "#f8fafc", "#fda4af"]),
      size: 2.4,
      gravity: 0.02,
      drag: 0.995,
      glitter: false,
      trail: true,
      crackle: true,
    },
  };
}

/** Giọt nhũ vàng rơi lấp lánh khắp chiều ngang. */
function glitterDrizzle(w: number, h: number): Particle[] {
  return Array.from({ length: 34 }, () => ({
    x: Math.random() * w,
    y: Math.random() * h * 0.5,
    vx: (Math.random() - 0.5) * 0.3,
    vy: 0.4 + Math.random() * 0.7,
    life: 0,
    maxLife: 130 + Math.random() * 60,
    color: pick(["#fde047", "#fbbf24", "#f59e0b", "#fef3c7"]),
    size: 1 + Math.random() * 1.5,
    gravity: 0.004,
    drag: 1,
    glitter: true,
  }));
}

/** Mảnh giấy màu vuông rơi xoay như confetti thật. */
function confettiFall(w: number, h: number): Particle[] {
  return Array.from({ length: 60 }, () => ({
    x: Math.random() * w,
    y: -20 - Math.random() * h * 0.45,
    vx: (Math.random() - 0.5) * 1.2,
    vy: 1.6 + Math.random() * 2,
    life: 0,
    maxLife: 230,
    color: pick(CONFETTI_COLORS),
    size: 3 + Math.random() * 3.5,
    gravity: 0.008,
    drag: 0.999,
    glitter: false,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.28,
  }));
}

/** Vài chiếc cà rem/xe máy bay lên lẫn trong pháo. */
function emojiFloat(w: number, h: number): Particle[] {
  return Array.from({ length: 6 }, () => ({
    x: w * (0.1 + Math.random() * 0.8),
    y: h * (0.55 + Math.random() * 0.35),
    vx: (Math.random() - 0.5) * 0.8,
    vy: -1.1 - Math.random() * 0.9,
    life: 0,
    maxLife: 190,
    color: "#fff",
    size: 20 + Math.floor(Math.random() * 14),
    gravity: -0.004,
    drag: 1,
    glitter: false,
    emoji: pick(EMOJIS),
  }));
}

function showBanner(parent: HTMLElement, detail?: string) {
  const banner = document.createElement("div");
  banner.className = "sale-celebrate-banner";
  const ribbon = document.createElement("em");
  ribbon.className = "sale-celebrate-ribbon";
  ribbon.textContent = "✦ CÀ REM XIN CHÚC MỪNG ✦";
  const line = document.createElement("strong");
  line.textContent = pick(HEADLINES);
  const sub = document.createElement("span");
  sub.textContent = detail || pick(SUBLINES);
  banner.append(ribbon, line, sub);
  parent.appendChild(banner);
  window.setTimeout(() => banner.classList.add("leaving"), BANNER_MS);
}

export function celebrateSale2D(options: CelebrateOptions = {}) {
  // Chỉ chạy trên trình duyệt; mọi lỗi phụ họa đều bị nuốt để không ảnh
  // hưởng luồng bán đã được ghi nhận thành công.
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try {
    // Người dùng yêu cầu giảm chuyển động: bỏ pháo hoa, giữ lời chúc nhẹ.
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const overlay = document.createElement("div");
    overlay.className = "sale-celebrate";
    overlay.setAttribute("role", "presentation");

    const rays = document.createElement("div");
    rays.className = "sale-celebrate-rays";
    rays.setAttribute("aria-hidden", "true");
    overlay.appendChild(rays);

    // Khung nghi lễ hào hùng: viền vàng chạm góc + hint tắt sớm. Letterbox
    // điện ảnh do ::before/::after của .sale-celebrate lo (bên dưới).
    const frame = document.createElement("div");
    frame.className = "sale-celebrate-frame";
    frame.setAttribute("aria-hidden", "true");
    overlay.appendChild(frame);

    const hint = document.createElement("div");
    hint.className = "sale-celebrate-hint";
    hint.setAttribute("aria-hidden", "true");
    hint.textContent = "✦ Bấm vào màn hình để kết thúc sớm ✦";
    overlay.appendChild(hint);

    showBanner(overlay, options.detail);

    let particles: Particle[] = [];
    let shells: { p: Particle; explodeAt: number }[] = [];
    let stopped = false;
    let stopLoop: (() => void) | null = null;

    if (!reduceMotion) {
      const canvas = document.createElement("canvas");
      canvas.className = "sale-celebrate-canvas";
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // Canvas trên cùng (chồng lên tia xoay) nhưng dưới banner: CSS lo thứ tự.
      overlay.prepend(canvas);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let w = 0;
      let h = 0;
      const resize = () => {
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      resize();
      window.addEventListener("resize", resize);

      // ---- Rồng 3D uốn lượn phủ toàn màn hình ----
      const dragonHistory: DragonPoint[] = [];
      // Mẫu quỹ đạo tại vị trí thập phân giữa hai khớp lịch sử: nội suy để
      // thân rồng liền mạch dù đầu bay nhanh hơn khoảng cách lấy mẫu.
      const sampleDragon = (idx: number): DragonPoint => {
        const max = dragonHistory.length - 1;
        const f = Math.min(Math.max(idx, 0), max);
        const i0 = Math.floor(f);
        const i1 = Math.min(max, i0 + 1);
        const t = f - i0;
        const a = dragonHistory[i0];
        const b = dragonHistory[i1];
        return {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        };
      };
      const dragonHead = (elapsed: number): DragonPoint => {
        // ang quét ~1.8 vòng Lissajos trong 9.2 giây; hai sóng tần số cao
        // chồng lên tạo nhịp uốn như mình rắn đang bơi trong không gian.
        const ang = (elapsed / DRAGON_DURATION_MS) * Math.PI * 2 * 1.8;
        return {
          x: w * (0.5 + 0.56 * Math.sin(ang) + 0.05 * Math.sin(ang * 6.3 + 1)),
          y: h * (0.46 + 0.33 * Math.sin(ang * 1.6 + 0.7) + 0.06 * Math.sin(ang * 8.1)),
          z: Math.sin(ang * 0.83 + 1.4),
        };
      };
      // Nạp sẵn ~4 giây quỹ đạo "quá khứ" để rồng vào cảnh đã dài đầy thân,
      // không phải đuôi cụt lớn dần rồi mới dài ra.
      for (let i = DRAGON_WARMUP_FRAMES; i >= 1; i -= 1) {
        dragonHistory.push(dragonHead(-i * 16.7));
      }
      const drawDragon = (elapsed: number) => {
        if (elapsed > DRAGON_DURATION_MS) return;
        const fade =
          elapsed < 200
            ? elapsed / 200
            : elapsed > DRAGON_DURATION_MS - 700
              ? Math.max(0, (DRAGON_DURATION_MS - elapsed) / 700)
              : 1;
        dragonHistory.unshift(dragonHead(elapsed));
        if (dragonHistory.length > DRAGON_HISTORY_CAP) {
          dragonHistory.length = DRAGON_HISTORY_CAP;
        }
        // Rồng vẽ bằng source-over: khớp chồng khớp, cộng màu (lighter) sẽ
        // làm no trắng hết vảy ngọc - vàng; pháo hoa phía dưới vẫn rực riêng.
        ctx.globalCompositeOperation = "source-over";
        // Khổng lồ: bề ngang thân bằng ~1/10 chiều cao màn hình.
        const base = Math.min(w, h) * 0.052;
        // Chuỗi khớp phụ từ đuôi lên đầu (painter's algorithm): mỗi khớp mang
        // độ sâu z riêng nên thân tự loang/nhòe theo chiều không gian 3D.
        const SUB = DRAGON_SEGMENTS * 2;
        const pts: { p: DragonPoint; r: number; depth: number }[] = [];
        for (let j = SUB; j >= 0; j -= 1) {
          const i = (j / SUB) * DRAGON_SEGMENTS;
          const p = sampleDragon(i * DRAGON_CHAIN_SPACING);
          const depth = (p.z + 1) / 2;
          const taper = 0.2 + 0.9 * Math.pow(1 - i / DRAGON_SEGMENTS, 0.7);
          pts.push({ p, depth, r: base * (0.62 + 0.78 * depth) * taper });
        }
        ctx.lineCap = "round";
        // Lớp 1: quầng hơi vàng liên tục – rồng phát sáng như được thắp từ
        // trong. Lớp 2: thân vảy so le ngọc - vàng theo cụm dài.
        for (let k = 0; k < pts.length - 1; k += 1) {
          const a = pts[k];
          const b = pts[k + 1];
          ctx.globalAlpha = (0.05 + 0.08 * a.depth) * fade;
          ctx.strokeStyle = "#f59e0b";
          ctx.lineWidth = a.r * 3.2;
          ctx.beginPath();
          ctx.moveTo(a.p.x, a.p.y);
          ctx.lineTo(b.p.x, b.p.y);
          ctx.stroke();
        }
        for (let k = 0; k < pts.length - 1; k += 1) {
          const a = pts[k];
          const b = pts[k + 1];
          // Thân ngọc liền mạch, đậm dần khi lặn sâu; mỗi đai 8 khớp điểm
          // một vệt vàng nhạt như hàng vảy – rồng ta, không phải sọc kẹo.
          ctx.globalAlpha = (0.62 + 0.38 * a.depth) * fade;
          ctx.strokeStyle =
            a.depth > 0.66 ? "#10b981" : a.depth > 0.33 ? "#0ea371" : "#047857";
          ctx.lineWidth = a.r * 2;
          ctx.beginPath();
          ctx.moveTo(a.p.x, a.p.y);
          ctx.lineTo(b.p.x, b.p.y);
          ctx.stroke();
          if (k % 8 < 4) {
            ctx.globalAlpha = (0.16 + 0.2 * a.depth) * fade;
            ctx.strokeStyle = "#fcd34d";
            ctx.lineWidth = a.r * 1.5;
            ctx.beginPath();
            ctx.moveTo(a.p.x, a.p.y);
            ctx.lineTo(b.p.x, b.p.y);
            ctx.stroke();
          }
          // Lớp 3: bụng sáng – dải mảnh liền dưới sống lưng mỗi khớp.
          ctx.globalAlpha = (0.1 + 0.14 * a.depth) * fade;
          ctx.strokeStyle = "#fde68a";
          ctx.lineWidth = a.r * 0.55;
          ctx.beginPath();
          ctx.moveTo(a.p.x, a.p.y + a.r * 0.5);
          ctx.lineTo(b.p.x, b.p.y + b.r * 0.5);
          ctx.stroke();
          // Lớp 4: gai lưng màng vàng – tam giác nhỏ hướng lên mỗi 3 khớp.
          if (k % 3 === 0 && a.r > base * 0.25) {
            const dx = b.p.x - a.p.x;
            const dy = b.p.y - a.p.y;
            const len = Math.hypot(dx, dy) || 1;
            let nx = dy / len;
            let ny = -dx / len;
            if (ny > 0) {
              nx = -nx;
              ny = -ny;
            }
            ctx.globalAlpha = (0.25 + 0.3 * a.depth) * fade;
            ctx.fillStyle = "#f59e0b";
            ctx.beginPath();
            ctx.moveTo(a.p.x - (dx / len) * a.r * 0.55, a.p.y - (dy / len) * a.r * 0.55);
            ctx.lineTo(a.p.x + nx * a.r * 1.7, a.p.y + ny * a.r * 1.7);
            ctx.lineTo(a.p.x + (dx / len) * a.r * 0.55, a.p.y + (dy / len) * a.r * 0.55);
            ctx.closePath();
            ctx.fill();
          }
        }
        // Đầu rồng: quay theo vector chuyển động, giải phẫu nhiều lớp –
        // quầng sáng, bờm bay theo gió, sừng phân nhánh, mõm dài, quai hàm,
        // lỗ mũi, râu uốn, mắt hổ phách có mày nổi khối.
        const head = dragonHistory[0];
        const behind = dragonHistory[Math.min(4, dragonHistory.length - 1)];
        const depth = (head.z + 1) / 2;
        const r = base * (0.62 + 0.78 * depth) * 1.9;
        const angle = Math.atan2(head.y - behind.y, head.x - behind.x);
        ctx.save();
        ctx.translate(head.x, head.y);
        ctx.rotate(angle);
        ctx.globalAlpha = 0.3 * fade;
        ctx.fillStyle = "#fde047";
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 2.5, r * 1.7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineCap = "round";
        // Bờm vàng sau gáy: 5 tua lượn theo thời gian như đang bơi trong
        // gió – sắc vàng chọn để không tan vào thân ngọc.
        ctx.strokeStyle = "#fcd34d";
        ctx.lineWidth = r * 0.22;
        ctx.globalAlpha = fade * 0.55;
        for (let m = 0; m < 5; m += 1) {
          const spread = (m / 4 - 0.5) * 2.1;
          const len = r * (2.1 + 0.55 * Math.sin(elapsed * 0.012 + m * 1.7));
          ctx.beginPath();
          ctx.moveTo(-r * 0.6, spread * r * 0.7);
          ctx.quadraticCurveTo(-r * 1.5, spread * r * 1.5, -len, spread * r * 2.1);
          ctx.stroke();
        }
        // Sừng chính phân nhánh – nét tối làm viền rồi mới đến lõi sáng để
        // nổi trên cả nền trắng lẫn nền đêm; gốc choàng ngoài mép hộp sọ.
        for (const s of [-1, 1]) {
          for (const [width, color, alpha] of [
            [r * 0.42, "#92400e", 0.55],
            [r * 0.24, "#fde68a", 0.95],
          ] as const) {
            ctx.lineWidth = width;
            ctx.globalAlpha = fade * alpha;
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(-r * 0.4, s * r * 0.8);
            ctx.bezierCurveTo(-r * 1.1, s * r * 1.5, -r * 1.9, s * r * 1.7, -r * 2.5, s * r * 1.0);
            ctx.stroke();
          }
          ctx.lineWidth = r * 0.12;
          ctx.globalAlpha = fade * 0.8;
          ctx.strokeStyle = "#fde68a";
          ctx.beginPath();
          ctx.moveTo(-r * 1.45, s * r * 1.42);
          ctx.quadraticCurveTo(-r * 1.7, s * r * 2.0, -r * 2.2, s * r * 2.15);
          ctx.stroke();
        }
        // Hộp sọ + mõm dài đặc trưng rồng Việt.
        ctx.globalAlpha = fade * (0.85 + 0.15 * depth);
        ctx.fillStyle = "#fbbf24";
        ctx.beginPath();
        ctx.ellipse(-r * 0.1, 0, r * 1.35, r * 1.05, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(r * 1.35, 0, r * 1.05, r * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        // Gờ má tối hai bên – đầu có khối, không phẳng như mặt nạ.
        ctx.globalAlpha = fade * 0.35;
        ctx.fillStyle = "#d97706";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(-r * 0.15, s * r * 0.85, r * 1.05, r * 0.35, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // Quai hàm + lỗ mũi tạo khối.
        ctx.strokeStyle = "#b45309";
        ctx.lineWidth = r * 0.12;
        ctx.beginPath();
        ctx.moveTo(r * 2.2, r * 0.16);
        ctx.quadraticCurveTo(r * 1.2, r * 0.55, r * 0.2, r * 0.6);
        ctx.stroke();
        ctx.fillStyle = "#92400e";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(r * 2.15, s * r * 0.16, r * 0.09, 0, Math.PI * 2);
          ctx.fill();
        }
        // Râu rồng bay phần phật trước mũi: hai nét nền tối + lõi sáng.
        for (const s of [-1, 1]) {
          const sway = Math.sin(elapsed * 0.015 + s * 2) * r * 0.5;
          for (const [width, color, alpha] of [
            [r * 0.2, "#92400e", 0.45],
            [r * 0.1, "#fef3c7", 0.9],
          ] as const) {
            ctx.lineWidth = width;
            ctx.globalAlpha = fade * alpha;
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(r * 2.2, s * r * 0.25);
            ctx.bezierCurveTo(
              r * 3.0, s * (r * 0.9 + sway * 0.3),
              r * 3.4, s * (r * 1.6 + sway),
              r * 2.9, s * (r * 2.2 + sway),
            );
            ctx.stroke();
          }
        }
        // Mắt: lòng trắng hẹp, đồng tử dọc sắc bản, mày trễ hiểm – rồng
        // chứ không phải mắt ếch tròn to.
        for (const s of [-1, 1]) {
          ctx.globalAlpha = fade;
          ctx.fillStyle = "#fff7ed";
          ctx.beginPath();
          ctx.ellipse(r * 0.15, s * r * 0.52, r * 0.26, r * 0.2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#7c2d12";
          ctx.beginPath();
          ctx.ellipse(r * 0.22, s * r * 0.52, r * 0.09, r * 0.17, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#b45309";
          ctx.lineWidth = r * 0.14;
          ctx.beginPath();
          ctx.moveTo(-r * 0.25, s * r * 0.74);
          ctx.quadraticCurveTo(r * 0.15, s * r * 0.8, r * 0.45, s * r * 0.64);
          ctx.stroke();
        }
        ctx.restore();
        ctx.globalCompositeOperation = "lighter";
      };

      const spawnBursts = (
        x: number,
        y: number,
        big: boolean,
        seed?: { color: string; count: number },
      ) => {
        const patterns = big
          ? [burstDouble, burstClassic, burstPalm, burstRing, burstFlash, burstGlitter]
          : [burstClassic, burstRing, burstGlitter];
        const pattern = pick(patterns);
        let batch = pattern(x, y);
        if (seed) {
          // Nứt secondary kế thừa màu đạn cha cho chuỗi nổ liền mạch.
          batch = batch.map((p) => ({ ...p, color: seed.color }));
          if (seed.count < batch.length) batch = batch.slice(0, seed.count);
        }
        particles = particles.concat(batch);
        if (particles.length > MAX_PARTICLES) {
          particles.splice(0, particles.length - MAX_PARTICLES);
        }
      };

      const burstWave = (big: boolean) => {
        spawnBursts(w * (0.15 + Math.random() * 0.7), h * (0.12 + Math.random() * 0.4), big);
      };

      // Khai mạc ĐỒNG BỘ trước khung hình đầu – nếu trễ, tick thấy hạt rỗng
      // sẽ tắt loop và cả màn pháo im lìm (lỗi race đã QA bắt).
      burstWave(true);
      burstWave(true);
      spawnBursts(w / 2, h * 0.3, true);
      for (let i = 0; i < 4; i += 1) shells.push(makeShell(w, h));
      particles = particles.concat(confettiFall(w, h), emojiFloat(w, h), glitterDrizzle(w, h));

      // Biên đạo 10 giây: sóng pháo rải đều từ đầu tới gần cuối, tên lửa bắn
      // liên tục, finale bùng nổ giây 8.3-9.2 rồi nhường cảnh gập màn.
      const waveDelays = [
        500, 1000, 1500, 2050, 2600, 3150, 3700, 4250, 4800, 5400, 6000, 6600, 7200, 7800,
      ];
      for (const delay of waveDelays) {
        setTimeout(() => {
          if (!stopped) burstWave(Math.random() < 0.55);
        }, delay);
      }
      const launchDelays = [
        600, 1300, 2000, 2700, 3400, 4100, 4800, 5500, 6200, 6900, 7600,
      ];
      for (const delay of launchDelays) {
        setTimeout(() => {
          if (!stopped && shells.length < 6) shells.push(makeShell(w, h));
        }, delay);
      }
      for (const delay of [8300, 8600, 8900, 9200]) {
        setTimeout(() => {
          if (stopped) return;
          burstWave(true);
          burstWave(true);
          spawnBursts(w * (0.2 + Math.random() * 0.6), h * (0.15 + Math.random() * 0.3), true);
        }, delay);
      }

      // Pháo chân thực hơn: mỗi quả shell đang bay rắc tia lửa ngắn theo quỹ đạo.
      const shellSparks = (p: Particle) => {
        if (particles.length >= MAX_PARTICLES || Math.random() > 0.4) return;
        particles.push({
          x: p.x + (Math.random() - 0.5) * 2,
          y: p.y,
          vx: (Math.random() - 0.5) * 0.4,
          vy: 0.3 + Math.random() * 0.5,
          life: 0,
          maxLife: 14 + Math.random() * 10,
          color: p.color,
          size: 1 + Math.random() * 0.8,
          gravity: 0.02,
          drag: 0.94,
          glitter: true,
        });
      };

      const drawParticle = (p: Particle, alpha: number) => {
        ctx.globalAlpha = alpha;
        if (p.emoji) {
          ctx.font = `${p.size}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(p.emoji, p.x, p.y);
        } else if (p.trail) {
          // Vệt dài theo hướng bay: tên lửa lên / sao băng.
          const speed = Math.hypot(p.vx, p.vy) || 1;
          const len = Math.min(26, 4 + speed * 2.6);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.size;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - (p.vx / speed) * len, p.y - (p.vy / speed) * len);
          ctx.stroke();
        } else if (p.spin !== undefined) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation ?? 0);
          ctx.fillStyle = p.color;
          // Hai mặt của mảnh giấy đổi sắc khi xoay như confetti thật.
          const face = Math.abs(Math.cos(p.rotation ?? 0));
          ctx.globalAlpha = alpha * (0.45 + 0.55 * face);
          ctx.fillRect(-p.size / 2, -p.size * 0.9, p.size, p.size * 1.8);
          ctx.restore();
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      };

      const startedAt = performance.now();
      let last = startedAt;
      const tick = (now: number) => {
        if (stopped) return;
        const dt = Math.min(2.5, (now - last) / 16.7);
        last = now;
        // Xóa hẳn rồi cộng màu (lighter) cho vệt nổ rực trên cả nền dim.
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, w, h);
        ctx.globalCompositeOperation = "lighter";
        const alive: Particle[] = [];
        for (const p of particles) {
          p.life += dt;
          const dying = p.life >= p.maxLife;
          if (dying && p.crackle) {
            spawnBursts(p.x, p.y, false, {
              color: p.color,
              count: 7 + Math.floor(Math.random() * 6),
            });
          }
          if (dying) continue;
          p.vy += p.gravity * dt;
          p.vx *= Math.pow(p.drag, dt);
          p.vy *= Math.pow(p.drag, dt);
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.rotation !== undefined && p.spin !== undefined) {
            p.rotation += p.spin * dt;
          }
          const t = p.life / p.maxLife;
          let alpha = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
          if (p.glitter) alpha *= 0.55 + 0.45 * Math.sin(p.life * 0.55);
          alpha = Math.max(0, Math.min(1, alpha));
          drawParticle(p, alpha);
          alive.push(p);
        }
        particles = alive;
        const nextShells: typeof shells = [];
        for (const s of shells) {
          const p = s.p;
          p.life += dt;
          if (p.life >= p.maxLife) {
            spawnBursts(p.x, p.y, true, { color: p.color, count: 34 });
            continue;
          }
          p.vy += p.gravity * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          shellSparks(p);
          drawParticle(p, 1);
          nextShells.push(s);
        }
        shells = nextShells;
        // Rồng khổng lồ lượn phía trên trường pháo hoa.
        drawDragon(now - startedAt);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        // Giữ loop tới hết vòng đời overlay: khoảng hở giữa các đợt burst
        // không được tắt máy sớm; removeOverlay gọi stopLoop khi người dùng tắt.
        if (now - startedAt < LIFETIME_MS) {
          requestAnimationFrame(tick);
        } else {
          stopLoop?.();
        }
      };
      stopLoop = () => {
        stopped = true;
        window.removeEventListener("resize", resize);
      };
      requestAnimationFrame(tick);
    }

    let removed = false;
    const removeOverlay = () => {
      if (removed) return;
      removed = true;
      // Chặn các đợt burst/loop muộn khi người dùng đã bấm tắt sớm.
      stopLoop?.();
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), FADE_MS);
    };
    document.body.appendChild(overlay);
    setTimeout(removeOverlay, LIFETIME_MS);

    // Bấm vào màn hình là tắt sớm – không bắt người dùng chờ xem pháo.
    window.addEventListener("pointerdown", removeOverlay, { once: true });
  } catch {
    // Phụ họa không bao giờ được làm hỏng giao dịch vừa thành công.
  }
}
