/**
 * tetCinematic.ts — engine of the Tết 2027 cinematic opening.
 *
 * Faithful port of carem-tet2027-studio/cinematic-prototype-v1/cinematic.js
 * (OWNER decision: the cinematic prototype is an INDEPENDENT module). Stripped
 * for production: the ?cine query protocol, the FPS HUD, the replay chips and
 * the __cineSeek capture API are prototype tooling, not product.
 *
 * Invariants kept from the prototype:
 *  - nothing ever touches the business DOM — the whole story is one fixed
 *    overlay appended to <body> and removed again on finish();
 *  - the theme reveal is a callback: the caller decides what "behind the
 *    curtain" means (here: data-seasonal="tet"), the engine never edits
 *    Light/Dark and never writes React state;
 *  - every rAF, listener and timer created here is destroyed by the returned
 *    handle — a skipped or unmounted opening must leave zero live callbacks.
 */

export type CinematicOptions = {
  /** resolved URL of the Dê Lái artwork (public asset). */
  src: string;
  caption: string;
  /** fired once, mid-wipe, when the app behind the curtain may be revealed. */
  onReveal: () => void;
  /** "Bỏ qua" pressed — the caller should record the per-device opt-out. */
  onNever: () => void;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const outBack = (p: number) => {
  const c = 1.28;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};
const inOutQuart = (p: number) =>
  p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2;
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/* Timeline, in ms — the prototype's shot list, unchanged. */
const T = {
  barIn: [0, 500],
  awaken: [400, 2200],
  entrance: [1900, 3900],
  burst: [3600, 5600],
  wipe: [5400, 7100],
  finale: [6900, 8400],
  out: [8400, 8900],
} as const;
const END = 8900;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rot: number;
  vr: number;
  sway: number;
  swayV: number;
  depth: number;
  scale: number;
  hue: number;
  lit: boolean;
  life: number;
  spark?: boolean;
  decay?: number;
  trail?: { x: number; y: number }[];
};

/** Canvas2D petals in three depth layers + burst sparks with light trails.
 *  No WebGL: cheap GPUs on shop phones must not disqualify the effect. */
function createParticles(canvas: HTMLCanvasElement, mobile: boolean) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, mobile ? 1.5 : 2);
  let W = 0;
  let H = 0;
  const list: Particle[] = [];
  const MAX = mobile ? 46 : 110;
  const BUDGET = { far: 0.45, mid: 0.4 };

  const resize = () => {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const petal = (depth: number): Particle => {
    const scale = depth === 2 ? 1.9 : depth === 1 ? 1 : 0.55;
    const gold = Math.random() < 0.78;
    return {
      x: Math.random() * W,
      y: -30 - Math.random() * H * 0.6,
      vx: (Math.random() - 0.5) * (depth === 2 ? 40 : 22),
      vy: 34 + Math.random() * 60 * scale,
      r: (5 + Math.random() * 6) * scale,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 2.6,
      sway: Math.random() * Math.PI * 2,
      swayV: 0.6 + Math.random() * 1.4,
      depth,
      scale,
      hue: gold ? 42 + Math.random() * 10 : 20 + Math.random() * 8,
      lit: Math.random() < 0.3,
      life: 1,
    };
  };
  const spark = (x: number, y: number): Particle => {
    const a = Math.random() * Math.PI * 2;
    const v = 120 + Math.random() * 340;
    return {
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 90,
      r: 1 + Math.random() * 2.2,
      rot: 0,
      vr: 0,
      sway: 0,
      swayV: 0,
      depth: 1,
      scale: 1,
      hue: 46,
      lit: true,
      life: 1,
      spark: true,
      decay: 0.5 + Math.random() * 0.9,
      trail: [],
    };
  };

  return {
    resize,
    clear: () => {
      list.length = 0;
    },
    count: () => list.length,
    seedAmbient: (n: number) => {
      for (let i = 0; i < n && list.length < MAX; i++) {
        const d = Math.random() < BUDGET.far ? 0 : Math.random() < 0.72 ? 1 : 2;
        const p = petal(d);
        p.y = Math.random() * H;
        list.push(p);
      }
    },
    burst: (x: number, y: number, n: number) => {
      for (let i = 0; i < n && list.length < MAX + 40; i++) list.push(spark(x, y));
      for (let i = 0; i < Math.round(n * 0.5) && list.length < MAX + 60; i++) {
        const d = Math.random() < 0.4 ? 1 : 2;
        const p = petal(d);
        p.x = x + (Math.random() - 0.5) * 220;
        p.y = y + (Math.random() - 0.5) * 160;
        p.vx = (Math.random() - 0.5) * 160;
        p.vy = -60 - Math.random() * 120;
        list.push(p);
      }
    },
    step: (dt: number, gravity: number) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        if (p.spark) {
          p.trail!.push({ x: p.x, y: p.y });
          if (p.trail!.length > 7) p.trail!.shift();
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vy += 420 * dt * gravity;
          p.vx *= 0.985;
          p.life -= (p.decay ?? 1) * dt;
          if (p.life <= 0) list.splice(i, 1);
          continue;
        }
        p.sway += p.swayV * dt;
        p.x += (p.vx + Math.sin(p.sway) * 26 * p.scale) * dt;
        p.y += p.vy * dt * gravity;
        p.rot += p.vr * dt;
        if (p.y > H + 40) {
          if (list.length > MAX * 0.8) list.splice(i, 1);
          else {
            p.y = -30;
            p.x = Math.random() * W;
          }
        }
      }
    },
    draw: (blurNear: boolean) => {
      ctx.clearRect(0, 0, W, H);
      for (const p of list) {
        if (p.spark) {
          ctx.save();
          ctx.globalAlpha = Math.max(p.life, 0) * 0.95;
          ctx.strokeStyle = "hsl(46,92%,72%)";
          ctx.lineWidth = p.r;
          ctx.lineCap = "round";
          ctx.beginPath();
          const trail = p.trail!;
          if (trail.length) {
            ctx.moveTo(trail[0].x, trail[0].y);
            for (let j = 1; j < trail.length; j++) ctx.lineTo(trail[j].x, trail[j].y);
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
          ctx.fillStyle = "#fff3c8";
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 0.9, 0, 6.284);
          ctx.fill();
          ctx.restore();
          continue;
        }
        const alpha = p.depth === 0 ? 0.34 : p.depth === 1 ? 0.72 : 0.9;
        const blurOut = p.depth === 2 && blurNear ? 0.66 : 1;
        ctx.save();
        ctx.globalAlpha = alpha * blurOut;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, 0.62 + 0.38 * Math.abs(Math.cos(p.rot)));
        const grd = ctx.createRadialGradient(0, 0, p.r * 0.15, 0, 0, p.r * 1.7);
        grd.addColorStop(0, `hsl(${p.hue},96%,${p.lit ? 82 : 66}%)`);
        grd.addColorStop(1, `hsla(${p.hue},90%,44%,0.06)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r * 1.6, p.r, 0, 0, 6.284);
        ctx.fill();
        ctx.restore();
      }
    },
  };
}

type Particles = NonNullable<ReturnType<typeof createParticles>>;

/**
 * Plays the opening inside `host` and resolves the returned promise when the
 * stage is fully gone (finished, skipped or unmounted). `stop()` is the hard
 * teardown for React cleanup.
 */
export function playCinematicOpening(host: HTMLElement, opts: CinematicOptions) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    // The festive layer itself is what matters; never animate against the setting.
    opts.onReveal();
    let settled = false;
    return {
      stop: () => {
        if (!settled) {
          settled = true;
        }
      },
      done: Promise.resolve(),
    };
  }

  const isMobile = (globalThis.innerWidth ?? 1280) < 768;
  const stage = document.createElement("div");
  stage.className = "tet-cine-stage";
  stage.setAttribute("aria-hidden", "true");
  stage.innerHTML =
    '<div class="cine-void"></div>' +
    '<div class="cine-sweep"></div>' +
    '<canvas class="cine-dust cine-speed"></canvas>' +
    '<div class="cine-plate"><img alt="Dê Lái cưỡi xe máy chở xuân về nhà" /><div class="cine-plate-grade"></div></div>' +
    '<div class="cine-curtain"></div>' +
    '<canvas class="cine-fx"></canvas>' +
    '<div class="cine-bar top"></div><div class="cine-bar bottom"></div>' +
    '<div class="cine-caption"></div>' +
    '<button class="cine-never" type="button">Không chiếu màn chào nữa</button>' +
    '<button class="cine-skip" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4l10 8-10 8z" fill="currentColor" stroke="none"/><path d="M19 4v16"/></svg><span>Bỏ qua</span></button>';
  host.appendChild(stage);

  const find = <S extends Element>(selector: string) =>
    stage.querySelector<S>(selector);
  const voidEl = find<HTMLDivElement>(".cine-void")!;
  const sweepEl = find<HTMLDivElement>(".cine-sweep")!;
  const plateEl = find<HTMLDivElement>(".cine-plate")!;
  const curtainEl = find<HTMLDivElement>(".cine-curtain")!;
  const captionEl = find<HTMLDivElement>(".cine-caption")!;
  const fxCanvas = find<HTMLCanvasElement>(".cine-fx")!;
  const speedCanvas = find<HTMLCanvasElement>(".cine-speed")!;
  captionEl.textContent = opts.caption;

  const img = plateEl.querySelector("img")!;
  img.src = opts.src;

  const fx: Particles | null = createParticles(fxCanvas, isMobile);
  if (!fx) {
    stage.classList.add("cine-fallback");
    plateEl.style.display = "none";
  }

  // The plate is the story; if the artwork cannot load, carry on without it
  // rather than show a broken frame for eight seconds.
  let hasPlate = !!fx;
  img.onerror = () => {
    hasPlate = false;
    plateEl.style.display = "none";
  };

  const scrollLock = document.createElement("style");
  scrollLock.textContent = "html,body{overflow:hidden!important}";
  document.head.appendChild(scrollLock);

  let raf = 0;
  let t0 = 0;
  let tCur = 0;
  let playing = true;
  let switched = false;
  let burstDone = false;
  let finInit = false;
  let finDx = 0;
  let finDy = 0;
  let finTarget = 1;
  let removeTimer = 0;
  let settled = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") finish();
  };
  window.addEventListener("keydown", onKey);
  find(".cine-skip")!.addEventListener("click", finish);
  find(".cine-never")!.addEventListener("click", () => {
    opts.onNever();
    finish();
  });

  function render(t: number, dt: number) {
    voidEl.style.opacity = String(seg(t, 0, 700));
    let p = seg(t, T.awaken[0], T.awaken[1]);
    sweepEl.style.transform = `translateX(${p * 220}vw) skewX(-14deg)`;
    sweepEl.style.opacity = p > 0 && p < 1 ? "1" : "0";

    // S2 entrance
    p = outBack(seg(t, T.entrance[0], T.entrance[1]));
    const blur =
      t < T.entrance[1] ? lerp(16, 0, clamp01((t - T.entrance[0]) / 1400)) : 0;
    const x = lerp(120, 0, p);
    const rot = lerp(7, 0, p);
    const sc = lerp(1.16, 1, p);
    const bob =
      t > T.entrance[1] && t < T.finale[0] ? Math.sin(t / 420) * 0.9 : 0;
    if (hasPlate && t < T.finale[0]) {
      plateEl.style.transform = `translate3d(calc(-50% + ${x}vw), calc(-50% + ${bob}vh), 0) rotate(${rot}deg) scale(${sc})`;
    }
    plateEl.style.opacity = String(seg(t, T.entrance[0], T.entrance[0] + 420));
    plateEl.style.filter = blur > 0.4 ? `blur(${blur.toFixed(1)}px)` : "none";

    const sl =
      clamp01((t - T.entrance[0] - 150) / 500) *
      clamp01((T.entrance[1] + 250 - t) / 600);
    speedCanvas.style.opacity = String(sl * 0.85);
    if (sl > 0.02) drawSpeed(sl, t);

    // S3 burst
    if (!burstDone && t >= T.burst[0]) {
      burstDone = true;
      fx?.burst(innerWidth / 2, innerHeight / 2, isMobile ? 34 : 80);
    }
    captionEl.style.opacity = String(
      seg(t, T.burst[0] + 300, T.burst[0] + 900) *
        clamp01((T.wipe[1] - t) / 500),
    );

    // S4 wipe — the one theme write of the whole module, via callback.
    p = inOutQuart(seg(t, T.wipe[0], T.wipe[1]));
    const a = lerp(-60, 118, p);
    const b = a + 46;
    curtainEl.style.clipPath = `polygon(${a}% 0%, ${b}% 0%, ${b - 24}% 100%, ${a - 24}% 100%)`;
    if (!switched && p >= 0.5) {
      switched = true;
      opts.onReveal();
    }

    // S5 finale: the plate flies home to the hero banner (measured once).
    p = seg(t, T.finale[0], T.finale[1]);
    if (hasPlate && p > 0) {
      const e = inOutQuart(p);
      if (!finInit) {
        finInit = true;
        const hero = document.getElementById("heroBanner");
        const pr0 = plateEl.getBoundingClientRect();
        if (hero) {
          const hr0 = hero.getBoundingClientRect();
          finDx = hr0.left + hr0.width / 2 - pr0.left - pr0.width / 2;
          finDy = hr0.top + hr0.height / 2 - pr0.top - pr0.height / 2;
          finTarget = Math.max(0.16, Math.min(hr0.width / pr0.width, 1.05));
        } else {
          finDx = 0;
          finDy = innerHeight * 0.3 - pr0.top - pr0.height / 2;
          finTarget = 0.4;
        }
      }
      const s = lerp(1, finTarget, e);
      const arc = Math.sin(e * Math.PI) * -6;
      plateEl.style.transform =
        `translate3d(calc(-50% + ${x * (1 - e)}vw + ${finDx * e}px), ` +
        `calc(-50% + ${finDy * e}px + ${arc}vh), 0) ` +
        `rotate(${rot * (1 - e)}deg) scale(${s})`;
      plateEl.style.opacity = String(1 - seg(t, T.finale[1] - 500, T.finale[1]));
    }

    if (fx) {
      const grav = t > T.finale[0] ? lerp(1, 0.25, seg(t, T.finale[0], END)) : 1;
      fx.step(dt / 1000, grav);
      fx.draw(t < T.burst[1]);
    }

    if (t >= T.barIn[0]) stage.classList.add("cine-hasbars");
    if (t >= T.finale[0] + 900) stage.classList.remove("cine-hasbars");
    if (t >= T.out[0]) stage.classList.add("cine-out");
  }

  function drawSpeed(intensity: number, t: number) {
    const c = x2d(speedCanvas);
    if (!c) return;
    const { ctx, w, h, dpr } = c;
    ctx.strokeStyle = `rgba(255,226,150,${(0.5 * intensity).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    const cy = h * 0.52;
    for (let i = 0; i < 26; i++) {
      const y = (i * 97.3) % h;
      const len = 60 + ((i * 53) % 180);
      const xo = (t * (0.5 + (i % 5) * 0.22) + i * 173) % (w + len);
      ctx.beginPath();
      ctx.moveTo(w - xo, y);
      ctx.lineTo(w - xo - len, y + (y - cy) * 0.04);
      ctx.stroke();
    }
    void dpr;
  }

  function frame(now: number) {
    if (!playing) return;
    const dt = Math.min(now - t0 - tCur, 50);
    tCur = now - t0;
    render(tCur, dt);
    if (tCur >= END) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function finish() {
    if (!playing && settled) return;
    playing = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    opts.onReveal(); // idempotent — guarantees the reveal even on an early skip
    stage.classList.add("cine-out");
    removeTimer = window.setTimeout(teardown, 650);
  }

  function teardown() {
    if (settled) return;
    settled = true;
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    if (removeTimer) clearTimeout(removeTimer);
    window.removeEventListener("keydown", onKey);
    scrollLock.remove();
    fx?.clear();
    stage.remove();
    resolveDone();
  }

  fx?.resize();
  fx?.seedAmbient(isMobile ? 20 : 42);
  t0 = performance.now();
  raf = requestAnimationFrame(frame);

  return {
    stop: teardown,
    done,
  };
}

function x2d(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}
