// Chúc mừng bán xe – màn "ra mắt" điện ảnh phủ toàn màn hình: nền dim có
// vignette, vòng tia vàng xoay, biểu ngữ hero chữ ánh kim và pháo hoa canvas
// nhiều tầng (shell bay có quỹ đạo, burst nứt hạt secondary, nhũ, confetti,
// emoji). Module thuần DOM/canvas, tự dọn dẹp, không kéo thêm thư viện và
// không chặn tương tác. Vui phải đi kèm lịch sự: bấm là tắt, tôn trọng
// prefers-reduced-motion, hạt bị cắt trần để máy yếu vẫn mượt.

export type CelebrateOptions = {
  /** Dòng banner phụ trong banner chính, ví dụ biển số hoặc mã xe vừa bán. */
  detail?: string;
};

const LIFETIME_MS = 4600;
const FADE_MS = 500;
const BANNER_MS = 3500;
// Trần số hạt đồng thời – thiết bị yếu vẫn chạy 60fps nhờ cắt từ đầu.
const MAX_PARTICLES = 950;

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

    const rays = document.createElement("div");
    rays.className = "sale-celebrate-rays";
    rays.setAttribute("aria-hidden", "true");
    overlay.appendChild(rays);

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
      for (let i = 0; i < 3; i += 1) shells.push(makeShell(w, h));
      particles = particles.concat(confettiFall(w, h), emojiFloat(w, h), glitterDrizzle(w, h));

      // Biên đạo: tên lửa bắn liên tục nửa đầu, burst ngẫu nhiên denser.
      const waveDelays = [500, 950, 1400, 1900, 2400, 2950, 3500];
      for (const delay of waveDelays) {
        setTimeout(() => {
          if (!stopped) burstWave(Math.random() < 0.55);
        }, delay);
      }
      const launchDelays = [560, 1150, 1750, 2350, 2900];
      for (const delay of launchDelays) {
        setTimeout(() => {
          if (!stopped && shells.length < 6) shells.push(makeShell(w, h));
        }, delay);
      }

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
          drawParticle(p, 1);
          nextShells.push(s);
        }
        shells = nextShells;
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
