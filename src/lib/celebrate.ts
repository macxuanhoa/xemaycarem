// Chúc mừng bán xe: một burst pháo hoa nhỏ phủ toàn màn hình kèm banner tinh
// quái chủ đề Cà Rem. Module thuần DOM/canvas, tự dọn dẹp sau ~3s, không kéo
// thêm thư viện và không chặn tương tác. Ưu tiên gọn – vui nhưng phải lịch sự.

export type CelebrateOptions = {
  /** Dòng banner phụ trong banner chính, ví dụ biển số hoặc mã xe vừa bán. */
  detail?: string;
};

const LIFETIME_MS = 3200;
const FADE_MS = 450;
const BANNER_MS = 2400;

// Bảng màu lễ hội: đủ sáng trên cả nền sáng lẫn dark theme.
const PALETTE = [
  "#f59e0b", "#ef4444", "#22c55e", "#38bdf8", "#a78bfa",
  "#f472b6", "#facc15", "#2dd4bf", "#fb923c", "#e879f9",
];

const CONFETTI_COLORS = ["#4f46e5", "#f59e0b", "#ef4444", "#22c55e", "#38bdf8", "#f472b6"];

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

type Burst = {
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
  emoji?: string;
  rotation?: number;
  spin?: number;
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Một vòng pháo hoa truyền thống: tia sáng tỏa đều rồi rơi dần. */
function burstClassic(x: number, y: number): Burst[] {
  const color = pick(PALETTE);
  const count = 26 + Math.floor(Math.random() * 14);
  const speed = 2.6 + Math.random() * 1.8;
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.18;
    const v = speed * (0.65 + Math.random() * 0.55);
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 62 + Math.random() * 26,
      color,
      size: 1.6 + Math.random() * 1.4,
      gravity: 0.045,
      drag: 0.968,
      glitter: Math.random() < 0.25,
    };
  });
}

/** Vòng ring tròn đều như bông cúc dẹt, bay chậm và lâu tàn hơn. */
function burstRing(x: number, y: number): Burst[] {
  const color = pick(PALETTE);
  const count = 30;
  const speed = 2.4 + Math.random() * 1.2;
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count;
    return {
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: 70 + Math.random() * 18,
      color,
      size: 2,
      gravity: 0.02,
      drag: 0.955,
      glitter: true,
    };
  });
}

/** Cọ vàng: tia bay vọt lên rồi rũ xuống như cành lá. */
function burstPalm(x: number, y: number): Burst[] {
  const color = pick(["#facc15", "#fb923c", "#f59e0b", "#fde047"]);
  const count = 12 + Math.floor(Math.random() * 6);
  return Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.3;
    const v = 4 + Math.random() * 2.4;
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 88 + Math.random() * 24,
      color,
      size: 2.2 + Math.random() * 1.2,
      gravity: 0.075,
      drag: 0.985,
      glitter: false,
    };
  });
}

/** Nhũ lấp lánh: chậm, nhỏ, nhấp nháy khi bay. */
function burstGlitter(x: number, y: number): Burst[] {
  const color = pick(PALETTE);
  return Array.from({ length: 20 + Math.floor(Math.random() * 10) }, () => {
    const angle = Math.random() * Math.PI * 2;
    const v = 0.6 + Math.random() * 1.6;
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 80 + Math.random() * 40,
      color,
      size: 1 + Math.random() * 1.4,
      gravity: 0.01,
      drag: 0.975,
      glitter: true,
    };
  });
}

/** Mảnh giấy màu vuông rơi xoay như confetti thật. */
function confettiFall(w: number, h: number): Burst[] {
  return Array.from({ length: 26 }, () => ({
    x: Math.random() * w,
    y: -20 - Math.random() * h * 0.3,
    vx: (Math.random() - 0.5) * 1.2,
    vy: 1.6 + Math.random() * 1.8,
    life: 0,
    maxLife: 150,
    color: pick(CONFETTI_COLORS),
    size: 3 + Math.random() * 3,
    gravity: 0.008,
    drag: 0.999,
    glitter: false,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.25,
  }));
}

/** Vài chiếc cà rem/xe máy bay lên lẫn trong pháo. */
function emojiFloat(w: number, h: number): Burst[] {
  return Array.from({ length: 3 }, () => ({
    x: w * (0.15 + Math.random() * 0.7),
    y: h * (0.55 + Math.random() * 0.35),
    vx: (Math.random() - 0.5) * 0.8,
    vy: -1.1 - Math.random() * 0.9,
    life: 0,
    maxLife: 130,
    color: "#fff",
    size: 20 + Math.floor(Math.random() * 10),
    gravity: -0.004,
    drag: 1,
    glitter: false,
    emoji: pick(EMOJIS),
  }));
}

function showBanner(parent: HTMLElement, detail?: string) {
  const banner = document.createElement("div");
  banner.className = "sale-celebrate-banner";
  const line = document.createElement("strong");
  line.textContent = pick(HEADLINES);
  const sub = document.createElement("span");
  sub.textContent = detail || pick(SUBLINES);
  banner.append(line, sub);
  parent.appendChild(banner);
  window.setTimeout(() => banner.classList.add("leaving"), BANNER_MS);
}

export function celebrateSale(options: CelebrateOptions = {}) {
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
    showBanner(overlay, options.detail);

    let particles: Burst[] = [];
    let stopped = false;
    let stopLoop: (() => void) | null = null;

    if (!reduceMotion) {
      const canvas = document.createElement("canvas");
      canvas.className = "sale-celebrate-canvas";
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
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

      const patterns = [burstClassic, burstClassic, burstRing, burstPalm, burstGlitter];
      const spawnWave = () => {
        const pattern = pick(patterns);
        const x = w * (0.18 + Math.random() * 0.64);
        const y = h * (0.14 + Math.random() * 0.4);
        particles = particles.concat(pattern(x, y));
        // Giới hạn hạt để thiết bị yếu vẫn mượt.
        if (particles.length > 420) particles.splice(0, particles.length - 420);
      };
      // Burst khai mạc spawn ĐỒNG BỘ trước khung hình đầu – nếu trễ, tick
      // thấy hạt rỗng sẽ tắt loop và cả màn pháo im lìm (lỗi race đã QA bắt).
      spawnWave();
      spawnWave();
      particles = particles.concat(confettiFall(w, h), emojiFloat(w, h));
      for (const delay of [420, 820, 1250, 1650]) {
        setTimeout(() => {
          if (!stopped) spawnWave();
        }, delay);
      }

      const startedAt = performance.now();
      let last = startedAt;
      const tick = (now: number) => {
        if (stopped) return;
        const dt = Math.min(2.5, (now - last) / 16.7);
        last = now;
        ctx.clearRect(0, 0, w, h);
        const alive: Burst[] = [];
        for (const p of particles) {
          p.life += dt;
          if (p.life >= p.maxLife) continue;
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
          ctx.globalAlpha = alpha;
          if (p.emoji) {
            ctx.font = `${p.size}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(p.emoji, p.x, p.y);
          } else if (p.spin !== undefined) {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation ?? 0);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.7);
            ctx.restore();
          } else {
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
          }
          alive.push(p);
        }
        particles = alive;
        ctx.globalAlpha = 1;
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
