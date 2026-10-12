// Chúc mừng bán xe – Lễ hội pháo hoa rực rỡ phủ lên giao diện gốc.
// Tên lửa bắn vọt từ chân màn hình lên không trung với vận tốc cao,
// để lại vệt lửa sáng rực, nổ tung thành các cụm hoa đăng, liễu vàng và pháo nhẫn đa sắc.

export type CelebrateOptions = {
  /** Dòng banner phụ trong banner chính, ví dụ biển số hoặc mã xe vừa bán. */
  detail?: string;
  /** Mã phiếu bán xe để cung cấp nút xem chi tiết trực tiếp trên banner. */
  saleId?: string;
  /** Callback khi người dùng bấm xem phiếu bán xe. */
  onViewSale?: () => void;
  /** Callback khi màn chúc mừng đóng lại. */
  onClose?: () => void;
};

const LIFETIME_MS = 10000;
const FADE_MS = 500;
const BANNER_MS = 9000;
const MAX_PARTICLES = 2500;

const PALETTE = [
  "#f59e0b", "#ef4444", "#22c55e", "#38bdf8", "#a78bfa",
  "#f472b6", "#facc15", "#2dd4bf", "#fb923c", "#e879f9",
  "#ffffff", "#fb7185", "#34d399", "#818cf8", "#f43f5e",
];

const GOLD_PALETTE = ["#facc15", "#fbbf24", "#f59e0b", "#fde047", "#fffbeb", "#fef08a"];

const CONFETTI_COLORS = [
  "#4f46e5", "#f59e0b", "#ef4444", "#22c55e", "#38bdf8",
  "#f472b6", "#fde047", "#10b981", "#8b5cf6", "#ec4899",
];

const EMOJIS = ["🏍️", "🛵", "🛴", "💰", "✨", "🎉", "🔥", "🍀"];

const HEADLINES = [
  "Chúc mừng bán xe thành công! 🎉",
  "Xe đã sang tay, tiền về rộn rã! 🎉",
  "Chốt đơn rực rỡ – Cà Rem hân hoan! 🎉",
  "Thêm một xe lên đường bình an! 🎉",
  "Giao dịch hoàn tất ngọt ngào! 🎉",
];

const SUBLINES = [
  "Thuận mua vừa bán – khách vui, showroom phát tài.",
  "Xe Máy Cà Rem chúc mừng, ra lộc may mắn!",
  "Chúc mừng giao dịch chốt đơn thành công xuất sắc!",
  "Khách hàng tin tưởng, doanh thu vững vàng.",
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
  trail?: boolean;
  crackle?: boolean;
  emoji?: string;
  rotation?: number;
  spin?: number;
};

type Shell = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  style: "peony" | "willow" | "ring" | "crackle" | "strobe" | "double";
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function burstPeony(x: number, y: number, color?: string): Particle[] {
  const c = color || pick(PALETTE);
  const count = 55 + Math.floor(Math.random() * 25);
  const speed = 3.8 + Math.random() * 2.8;
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.2;
    const v = speed * (0.55 + Math.random() * 0.55);
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 60 + Math.random() * 28,
      color: c,
      size: 2.0 + Math.random() * 1.6,
      gravity: 0.04,
      drag: 0.965,
      glitter: Math.random() < 0.35,
    };
  });
}

function burstWillow(x: number, y: number): Particle[] {
  const count = 44 + Math.floor(Math.random() * 20);
  const speed = 4.2 + Math.random() * 2.5;
  return Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const v = speed * (0.6 + Math.random() * 0.55);
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 95 + Math.random() * 35,
      color: pick(GOLD_PALETTE),
      size: 2.2 + Math.random() * 1.2,
      gravity: 0.062,
      drag: 0.982,
      glitter: true,
      trail: true,
    };
  });
}

function burstDoubleRing(x: number, y: number): Particle[] {
  const c1 = pick(PALETTE);
  let c2 = pick(PALETTE);
  if (c2 === c1) c2 = "#fde047";
  const makeRing = (count: number, speed: number, color: string, size: number) =>
    Array.from({ length: count }, (_, i) => {
      const angle = (Math.PI * 2 * i) / count;
      return {
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 70 + Math.random() * 20,
        color,
        size,
        gravity: 0.025,
        drag: 0.96,
        glitter: true,
      };
    });
  return [...makeRing(36, 3.8, c1, 2.2), ...makeRing(24, 2.1, c2, 1.8)];
}

function burstCracklePalm(x: number, y: number): Particle[] {
  const count = 26 + Math.floor(Math.random() * 12);
  const speed = 4.5 + Math.random() * 2.5;
  const color = pick(PALETTE);
  return Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.7;
    const v = speed * (0.7 + Math.random() * 0.5);
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 80 + Math.random() * 25,
      color,
      size: 2.2 + Math.random() * 1.4,
      gravity: 0.068,
      drag: 0.978,
      glitter: false,
      crackle: true,
    };
  });
}

function burstStrobeFlash(x: number, y: number): Particle[] {
  const color = pick(["#fef9c3", "#fde047", "#ffffff", "#67e8f9"]);
  const count = 28 + Math.floor(Math.random() * 12);
  return Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const v = 4.5 + Math.random() * 3.5;
    return {
      x, y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: 0,
      maxLife: 26 + Math.random() * 14,
      color,
      size: 1.6 + Math.random(),
      gravity: 0.02,
      drag: 0.91,
      glitter: false,
      trail: true,
    };
  });
}

function makeShell(w: number, h: number): Shell {
  const x = w * (0.06 + Math.random() * 0.88);
  const y = h + 15;
  // Bắn từ chân màn hình lên cực nhanh: 14.5 - 23 px/frame
  const vy = -(14.5 + Math.random() * 8.5);
  // Góc hơi nghiêng nhẹ hướng về phía trung tâm
  const centerBias = ((w / 2 - x) / (w / 2)) * 0.9;
  const vx = centerBias + (Math.random() - 0.5) * 2.2;
  // Điểm nổ ở độ cao 12% - 50% màn hình
  const targetY = h * (0.12 + Math.random() * 0.38);
  const maxLife = Math.max(16, Math.floor((y - targetY) / Math.abs(vy)));
  const styles: Shell["style"][] = ["peony", "willow", "ring", "crackle", "strobe", "double"];
  return {
    x, y,
    vx, vy,
    life: 0,
    maxLife,
    color: pick(PALETTE),
    size: 2.8 + Math.random() * 1.2,
    style: pick(styles),
  };
}

function confettiFall(w: number, h: number): Particle[] {
  return Array.from({ length: 60 }, () => ({
    x: Math.random() * w,
    y: -20 - Math.random() * h * 0.45,
    vx: (Math.random() - 0.5) * 1.2,
    vy: 1.4 + Math.random() * 2,
    life: 0,
    maxLife: 240,
    color: pick(CONFETTI_COLORS),
    size: 3 + Math.random() * 3.5,
    gravity: 0.008,
    drag: 0.999,
    glitter: false,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.28,
  }));
}

function emojiFloat(w: number, h: number): Particle[] {
  return Array.from({ length: 6 }, () => ({
    x: w * (0.1 + Math.random() * 0.8),
    y: h * (0.55 + Math.random() * 0.35),
    vx: (Math.random() - 0.5) * 0.8,
    vy: -1.2 - Math.random() * 0.9,
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

function showBanner(parent: HTMLElement, options: CelebrateOptions, dismiss: () => void) {
  const banner = document.createElement("div");
  banner.className = "sale-celebrate-banner";
  banner.addEventListener("pointerdown", (e) => e.stopPropagation());

  const ribbon = document.createElement("em");
  ribbon.className = "sale-celebrate-ribbon";
  ribbon.textContent = "✦ CÀ REM XIN CHÚC MỪNG ✦";

  const line = document.createElement("strong");
  line.textContent = pick(HEADLINES);

  const sub = document.createElement("span");
  sub.textContent = options.detail || pick(SUBLINES);

  banner.append(ribbon, line, sub);

  const actions = document.createElement("div");
  actions.className = "sale-celebrate-actions";

  if (options.onViewSale || options.saleId) {
    const viewBtn = document.createElement("button");
    viewBtn.className = "button primary celebrate-btn-view";
    viewBtn.textContent = "Xem phiếu bán xe";
    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dismiss();
      options.onViewSale?.();
    });
    actions.appendChild(viewBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "button secondary celebrate-btn-close";
  closeBtn.textContent = "Đóng";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
    options.onClose?.();
  });
  actions.appendChild(closeBtn);

  banner.appendChild(actions);
  parent.appendChild(banner);
  window.setTimeout(() => banner.classList.add("leaving"), BANNER_MS);
}

export function celebrateSale2D(options: CelebrateOptions = {}) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try {
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

    const frame = document.createElement("div");
    frame.className = "sale-celebrate-frame";
    frame.setAttribute("aria-hidden", "true");
    overlay.appendChild(frame);

    const hint = document.createElement("div");
    hint.className = "sale-celebrate-hint";
    hint.setAttribute("aria-hidden", "true");
    hint.textContent = "✦ Bấm vào màn hình để đóng ✦";
    overlay.appendChild(hint);

    let removed = false;
    let stopLoop: (() => void) | null = null;

    const removeOverlay = () => {
      if (removed) return;
      removed = true;
      stopLoop?.();
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), FADE_MS);
      options.onClose?.();
    };

    showBanner(overlay, options, removeOverlay);

    let shells: Shell[] = [];
    let particles: Particle[] = [];

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

      // Loạt pháo khai mạc: 5 quả bắn vọt lên ngay từ dưới gốc
      for (let i = 0; i < 5; i += 1) {
        shells.push(makeShell(w, h));
      }
      particles = particles.concat(confettiFall(w, h), emojiFloat(w, h));

      const explodeShell = (s: Shell) => {
        let batch: Particle[] = [];
        switch (s.style) {
          case "willow":
            batch = burstWillow(s.x, s.y);
            break;
          case "ring":
          case "double":
            batch = burstDoubleRing(s.x, s.y);
            break;
          case "crackle":
            batch = burstCracklePalm(s.x, s.y);
            break;
          case "strobe":
            batch = burstStrobeFlash(s.x, s.y);
            break;
          case "peony":
          default:
            batch = burstPeony(s.x, s.y, s.color);
            break;
        }
        particles = particles.concat(batch);
        if (particles.length > MAX_PARTICLES) {
          particles.splice(0, particles.length - MAX_PARTICLES);
        }
      };

      const shellSparks = (s: Shell) => {
        if (particles.length >= MAX_PARTICLES || Math.random() > 0.45) return;
        particles.push({
          x: s.x + (Math.random() - 0.5) * 3,
          y: s.y + Math.random() * 4,
          vx: (Math.random() - 0.5) * 0.8,
          vy: 1.2 + Math.random() * 1.5,
          life: 0,
          maxLife: 15 + Math.random() * 10,
          color: s.color,
          size: 1.2 + Math.random() * 1.0,
          gravity: 0.04,
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
          const speed = Math.hypot(p.vx, p.vy) || 1;
          const len = Math.min(28, 4 + speed * 2.8);
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
      let lastLaunch = startedAt;
      let nextInterval = 140;

      const tick = (now: number) => {
        if (removed) return;
        const dt = Math.min(2.5, (now - last) / 16.7);
        last = now;

        const elapsed = now - startedAt;

        // Bắn dồn dập liên tục như một lễ hội pháo hoa thực thụ
        if (elapsed < 9000 && now - lastLaunch >= nextInterval) {
          lastLaunch = now;
          // Giai đoạn cao trào (finale: 6.5s - 8.8s): bắn dày đặc 2-4 quả mỗi đợt
          const isFinale = elapsed > 6500 && elapsed < 8800;
          nextInterval = isFinale ? 85 + Math.random() * 45 : 130 + Math.random() * 80;
          const launchCount = isFinale ? 2 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2);
          for (let k = 0; k < launchCount; k += 1) {
            shells.push(makeShell(w, h));
          }
        }

        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, w, h);
        ctx.globalCompositeOperation = "lighter";

        // Cập nhật và vẽ các hạt pháo hoa
        const alive: Particle[] = [];
        for (const p of particles) {
          p.life += dt;
          const dying = p.life >= p.maxLife;
          if (dying && p.crackle) {
            const crackleBatch = burstPeony(p.x, p.y, p.color).slice(0, 8);
            particles.push(...crackleBatch);
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

        // Cập nhật và vẽ các quả tên lửa phóng từ dưới gốc lên
        const nextShells: Shell[] = [];
        for (const s of shells) {
          s.life += dt;
          if (s.life >= s.maxLife || s.y <= h * 0.1) {
            explodeShell(s);
            continue;
          }
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          shellSparks(s);

          // Vệt tên lửa sáng rực bay vút lên
          const speed = Math.hypot(s.vx, s.vy) || 1;
          const trailLen = Math.min(65, 8 + speed * 2.8);
          ctx.lineWidth = s.size;
          ctx.lineCap = "round";
          ctx.strokeStyle = s.color;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - (s.vx / speed) * trailLen, s.y - (s.vy / speed) * trailLen);
          ctx.stroke();

          // Đầu đạn trắng sáng
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.size * 0.85, 0, Math.PI * 2);
          ctx.fill();

          nextShells.push(s);
        }
        shells = nextShells;

        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";

        if (now - startedAt < LIFETIME_MS) {
          requestAnimationFrame(tick);
        } else {
          removeOverlay();
        }
      };

      stopLoop = () => {
        window.removeEventListener("resize", resize);
      };
      requestAnimationFrame(tick);
    }

    document.body.appendChild(overlay);
    window.setTimeout(removeOverlay, LIFETIME_MS);
    window.addEventListener("pointerdown", removeOverlay, { once: true });
  } catch {
    // Luồng pháo hoa phụ họa không bao giờ làm hỏng giao dịch
  }
}
