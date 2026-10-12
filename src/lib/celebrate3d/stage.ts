// Sân khấu 3D: máy quay, ánh sáng, môi trường phản chiếu vàng, mây nền,
// rồng, pháo hoa, lửa, bloom hậu kỳ, và vòng lặp thời gian 10 giây.
//
// Kiến trúc: một lớp presentation thuần tuý. Module KHÔNG chạm vào giao
// dịch, KHÔNG điều hướng, KHÔNG gọi API. Nó nhận `detail` để hiển thị và
// báo `onFinish` khi màn dạo đầu kết thúc. Mọi lỗi khi khởi tạo WebGL được
// ném ngược cho index.ts để rơi về bản pháo hoa 2D dự phòng — giao dịch đã
// thành công không bao giờ có thể bị hỏng vì hoạt hình.

import {
  ACESFilmicToneMapping,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  REVISION,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { Choreographer, TIMELINE } from "./choreo";
import { BONES, Dragon, SPACING } from "./dragon";
import { Flame } from "./flame";
import { Fireworks } from "./fireworks";
import { CelebrationOverlay } from "./overlay";
import { rand } from "./particles";
import { FrameBuilder, SpineSolver, makeFrames } from "./spine";
import {
  makeCloudCanvas,
  makeScaleColorCanvas,
  makeScaleNormalCanvas,
  makeScaleRoughnessCanvas,
  makeSkyCanvas,
} from "./textures";

export type Tier = "high" | "medium" | "low";

export type StageOptions = {
  detail?: string;
  tier?: Tier;
  reducedMotion?: boolean;
  onExit: () => void;
};

const QUALITY: Record<
  Tier,
  {
    dpr: number;
    rings: number;
    radial: number;
    whiskerEvery: number;
    fireworks: number;
    fire: number;
    sparks: number;
    bloom: boolean;
    clouds: number;
  }
> = {
  high: {
    dpr: 2,
    rings: 160,
    radial: 20,
    whiskerEvery: 2,
    fireworks: 4200,
    fire: 2600,
    sparks: 1400,
    bloom: true,
    clouds: 9,
  },
  medium: {
    dpr: 1.5,
    rings: 120,
    radial: 16,
    whiskerEvery: 3,
    fireworks: 2600,
    fire: 1600,
    sparks: 800,
    bloom: true,
    clouds: 6,
  },
  low: {
    dpr: 1.15,
    rings: 84,
    radial: 12,
    whiskerEvery: 4,
    fireworks: 1500,
    fire: 900,
    sparks: 450,
    bloom: false,
    clouds: 4,
  },
};

/** Thăm dò năng lực máy: nhân bản mobile + GPU phần mềm rơi về nấc thấp. */
export function detectTier(): Tier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 4;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 560;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(nav.userAgent);
  if (mobile || smallScreen || cores <= 4 || memory <= 4) return "low";
  if (cores <= 8) return "medium";
  return "high";
}

const LIFE_MS = 10000;
const FADE_MS = 600;

export function createStage(options: StageOptions) {
  const tier = options.tier ?? detectTier();
  const q = QUALITY[tier];

  const overlay = new CelebrationOverlay();
  const canvas = document.createElement("canvas");
  canvas.className = "dragon3d-canvas";
  overlay.root.prepend(canvas);

  const renderer: WebGLRenderer = new WebGLRenderer({
    canvas,
    antialias: tier !== "low",
    powerPreference: "high-performance",
    alpha: false,
  });
  let dprCap = Math.min(window.devicePixelRatio || 1, q.dpr);
  renderer.setPixelRatio(dprCap);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = false;

  const scene = new Scene();
  const skyTexture = new CanvasTexture(makeSkyCanvas());
  scene.background = skyTexture;
  scene.fog = new Fog(0x0b0722, 26, 74);

  // Môi trường studio để vàng CÓ phản chiếu góc cạnh (vàng không gương thì
  // không phải vàng). RoomEnvironment cho highlight đáng tin hơn HDR ngoài.
  const pmrem = new PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const envTexture = pmrem.fromScene(roomEnv, 0.04).texture;
  scene.environment = envTexture;
  // Studio env chỉ để lại SOLI trên cạnh vảy; để nguyên cường độ 1 thì cả
  // con rồng thành một khối trắng mất chi tiết.
  scene.environmentIntensity = 0.45;

  const camera = new PerspectiveCamera(48, window.innerWidth / Math.max(1, window.innerHeight), 0.1, 200);
  camera.position.set(0, 0.35, 16.6);

  // --- Ánh sáng nghi lễ ---------------------------------------------------
  // Ba nguồn có chủ đích: key ấm từ trên trái để vảy vàng nổi khối, rim
  // cam từ sau để tách rồng khỏi nền đêm, fill lạnh nhẹ cho phía tối. Tổng
  // công suất phải để lại vùng tối trên thân — vàng không có bóng tối thì
  // không còn là vàng nữa.
  const hemi = new HemisphereLight(0x4a3a86, 0x2a1405, 0.5);
  const key = new DirectionalLight(0xffd9a0, 1.65);
  key.position.set(-6, 8, 10);
  const rim = new DirectionalLight(0xff7a45, 1.35);
  rim.position.set(5, -3, -9);
  const fill = new DirectionalLight(0x9fc4ff, 0.35);
  fill.position.set(4, 6, 6);
  scene.add(hemi, key, rim, fill);

  // --- Mây nền: rồng xuyên qua mây ở cảnh 1 --------------------------------
  const cloudGroup = new Group();
  const cloudTexture = new CanvasTexture(makeCloudCanvas());
  const clouds: Mesh[] = [];
  for (let i = 0; i < q.clouds; i += 1) {
    const scale = rand(14, 26);
    const mesh = new Mesh(
      new PlaneGeometry(scale, scale * 0.62),
      new MeshBasicMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: rand(0.16, 0.34),
        depthWrite: false,
        color: new Color(i % 3 === 0 ? 0x6b4a86 : 0x2a1f4d),
      }),
    );
    mesh.position.set(rand(-14, 14), rand(-6, 9), rand(-24, -8));
    cloudGroup.add(mesh);
    clouds.push(mesh);
  }
  scene.add(cloudGroup);

  // --- Rồng ----------------------------------------------------------------
  const colorMap = new CanvasTexture(makeScaleColorCanvas(tier === "low" ? 512 : 1024));
  const normalMap = new CanvasTexture(makeScaleNormalCanvas(tier === "low" ? 512 : 1024));
  const roughnessMap = new CanvasTexture(makeScaleRoughnessCanvas(512));
  for (const t of [colorMap, normalMap, roughnessMap]) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  colorMap.colorSpace = SRGBColorSpace;

  const dragon = new Dragon(
    { rings: q.rings, radial: q.radial, whiskerEvery: q.whiskerEvery },
    { map: colorMap, normalMap, roughnessMap },
  );
  scene.add(dragon.group);

  const fireworks = new Fireworks(q.fireworks, tier === "low" ? 0.6 : 1);
  scene.add(fireworks.particles.points, fireworks.light);
  const flame = new Flame({
    fire: q.fire,
    sparks: q.sparks,
    // Không bloom thì hạt phải tự gánh phần dệt khối (xem ghi chú ở Flame).
    sizeScale: q.bloom ? 1 : 1.5,
  });
  scene.add(flame.fire.points, flame.sparks.points, flame.light);

  // --- Hậu kỳ: bloom nhẹ để lửa/pháo có ánh sáng điện ảnh ------------------
  // Ngưỡng cao (0.9) để chỉ hạt nhân thật sự cháy mới loe; loe cả khung
  // hình vàng = mất hết chi tiết vảy.
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(dprCap);
  composer.setSize(window.innerWidth, window.innerHeight);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const bloom = q.bloom
    ? new UnrealBloomPass(
        new Vector2(window.innerWidth, window.innerHeight),
        tier === "high" ? 0.42 : 0.32,
        0.5,
        0.9,
      )
    : null;
  if (bloom) composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // --- Biên đạo + vòng lặp --------------------------------------------------
  const choreo = new Choreographer();
  const solver = new SpineSolver(SPACING, BONES);
  const builder = new FrameBuilder();
  const frames = makeFrames(BONES);
  const points: Vector3[] = [];
  for (let i = 0; i < BONES; i += 1) points.push(new Vector3());
  const headPos = new Vector3();
  const headQuat = new Quaternion();
  const TMP_A = new Vector3();
  const TMP_B = new Vector3();
  const TMP_CAM = new Vector3();
  const TMP_ANCHOR = new Vector3();
  const clawTargets: (Vector3 | null)[] = [];
  const hips: Vector3[] = [];
  for (let i = 0; i < 4; i += 1) {
    clawTargets.push(null);
    hips.push(new Vector3());
  }

  // Thân rồng dài bao nhiêu thì tạo hình đậu dài bấy nhiêu: báo cho biên
  // đạo để đường cong dựng sẵn khớp đúng số đốt, không non/thừa đốt.
  choreo.setBodyLength((BONES - 1) * SPACING);
  // Nạp hồ sơ quỹ đạo "quá khứ" để rồng vào cảnh đã dài đầy thân.
  solver.warmup((t, out) => choreo.headPosition(t, out), -3.4, 3.4, points);

  // Lịch pháo hoa: rải từ đầu, dày dần ở finale, đúng tinh thần biên đạo.
  fireworks.schedule(0.3, 2, true);
  fireworks.schedule(1.2, 2, false);
  fireworks.schedule(2.2, 2, true);
  fireworks.schedule(3.4, 2, false);
  fireworks.schedule(4.4, 2, true);
  fireworks.schedule(5.4, 1, false);
  fireworks.schedule(6.2, 2, true);
  fireworks.schedule(8.6, 4, true);
  fireworks.schedule(9.2, 4, true);

  let stopped = false;
  let paused = false;
  let raf = 0;
  let startedAt = 0;
  let last = 0;
  let simTime = 0;
  let titleShown = false;
  let bannerShown = false;
  let impacted = false;
  // Neo sân khấu đã khoá chưa (xem poseAt bước 2).
  let anchorLocked = false;
  let anchorMeasured = false;
  // Đo hiệu năng thật để tự hạ độ phân giải khi tụt khung hình.
  let frameEma = 16.7;
  // Thang hạ DPR tính bằng THỜI GIAN chịu chậm, không tính bằng SỐ KHUNG.
  // Đếm khung thì máy rớt xuống 5 fps phải chờ ~24 khung ≈ 5 giây — nửa
  // cảnh chúc mừng 10 giây vẫn vẽ ở DPR cao. Tích luỹ mili giây thì mọi
  // máy đều chịu tối đa ~0,5 giây một bậc, nhanh nhất đúng lúc cần nhanh.
  let slowMs = 0;

  const resize = () => {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    camera.aspect = w / h;
    // Khung dọc: kéo máy quay ra xa + hạ FOV để rồng và chữ vẫn đủ khung.
    camera.fov = h > w ? 62 : 48;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom?.resolution.set(w, h);
    // Đổi khổ màn hình = đổi luôn tỷ lệ chữ–thế giới, phải mở khoá để sân
    // khấu tự đo lại từ DOM.
    anchorLocked = false;
    anchorMeasured = false;
  };
  resize();
  window.addEventListener("resize", resize);

  const bufSize = new Vector2();

  /**
   * Quy đổi đường kính thế giới của từng hạt sang pixel theo đúng phối
   * cảnh đang dùng. Pháo giữ trần nhỏ (chấm sáng xa), lửa cho phép to hơn
   * nhiều (thể tích khối lửa gần máy quay).
   */
  const syncParticleScale = () => {
    renderer.getDrawingBufferSize(bufSize);
    const scale = bufSize.y / (2 * Math.tan((camera.fov * Math.PI) / 360));
    fireworks.particles.setPointScale(scale, 26);
    flame.fire.setPointScale(scale, 64);
    flame.sparks.setPointScale(scale, 20);
  };

  /** Dựng toàn bộ tư thế cảnh tại giây t: rồng, máy quay, lửa, pháo, nhịp kể. */
  const poseAt = (t: number, dt: number) => {
    simTime = t;

    // 1) Máy quay đi TRƯỚC: mọi thứ neo vào mặt chữ đều được chiếu qua
    //    ống kính đang dùng, nên phải biết máy quay ở đâu mới đo được chữ
    //    bằng toạ độ thế giới. Đổi thứ tự ở đây = rồng đậu lệch chữ.
    const cam = choreo.camera(t, TMP_CAM);
    camera.position.copy(TMP_CAM);
    if (cam.shake > 0.001) {
      camera.position.x += rand(-1, 1) * cam.shake;
      camera.position.y += rand(-1, 1) * cam.shake;
    }
    camera.fov = (window.innerHeight > window.innerWidth ? 62 : 48) + (cam.fov - 48);
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0.4, 0);

    // 2) Neo sân khấu = mép trên khối chữ THẬT, đo từ DOM qua máy quay.
    //    Đo từ KHUNG HÌNH ĐẦU TIÊN, không chờ chữ hiện: overlay dùng hộp
    //    layout của chữ nên mặt chữ đã xác định từ trước khi reveal. Nhịp
    //    đầu nạp thẳng để cả đường bay không bị trượt theo đà lọc mượt; từ
    //    nhịp sau mới lọc mượt, và khoá lại sau nhịp chạm vì hiệu ứng nảy
    //    chữ (impact) chỉ là hoạt hình DOM 0.62s — thân rồng không được giật
    //    theo, chân đã bám thì phải giữ đúng điểm bám.
    if (!anchorLocked) {
      const box = overlay.titleAnchor(camera, TMP_ANCHOR);
      if (anchorMeasured) choreo.anchor.lerp(TMP_ANCHOR, 1 - Math.exp(-7 * dt));
      else {
        choreo.anchor.copy(TMP_ANCHOR);
        anchorMeasured = true;
      }
      choreo.setStage(box.height);
      dragon.setStance(choreo.bodyScale);
      if (t >= TIMELINE.contactAt) anchorLocked = true;
    }

    // 3) Đầu rồng theo biên đạo → chuỗi khớp cứng trượt dọc chính nó: thân
    //    giữ nguyên khoảng cách đốt và "nằm lại tại chỗ" khi đầu dừng.
    choreo.headPosition(t, headPos);
    solver.follow(headPos, points);

    // 4) Sóng bơi: rồng bơi trong không khí theo đúng nghĩa đen — biên độ
    //    dựng đứng (lên/xuống) vì up của rồng là +Y thế giới, cộng chút
    //    ngang cho thân có sinh khí khi đã đáp. Biên độ nhỏ dần về cổ để
    //    đầu bám tuyệt đối đúng quỹ đạo biên đạo.
    const swim = choreo.swim(t);
    const omega = 7.4;
    for (let i = 2; i < BONES; i += 1) {
      const s = i / BONES;
      const amp = 0.5 * Math.pow(s, 0.7) * swim;
      const wave = Math.sin(omega * t - s * 7.6);
      const side = Math.sin(omega * t * 0.63 - s * 4.1);
      points[i].y += wave * amp;
      points[i].x += side * amp * 0.26;
    }

    // 5) Tạo hình đậu: từ nhịp chạm, thân trộn dần sang đường cong ngồi
    //    trên chữ (tính bằng đơn vị cao độ chữ, neo vào mép trên khối chữ).
    const perch = choreo.perchBlend(t);
    if (perch > 0) choreo.applyPerch(points, perch, t);

    // 6) Khung hình đốt sống (up song song + banking khi rẽ).
    builder.build(points, frames, 2.4);

    // 7) Chân bám mặt chữ: mỗi móng tìm điểm trên chữ ngay dưới hông nó.
    const reach = choreo.legReach(t);
    if (reach > 0.001 && titleShown) {
      dragon.hipPositions(frames, hips);
      overlay.clawTargets(camera, hips, clawTargets);
      // Tự cân thế đứng khi thân đã về tạo hình đậu: khoảng cách hông→mặt
      // chữ trên màn 360×800 và 1920×1080 không giống nhau, nên để chính số
      // đo thật quyết định độ dài chân, mục tiêu duỗi ~82% tầm với — khuỵu
      // có trọng lượng chứ không chống hai cây sào thẳng đứng.
      if (reach > 0.5 && perch > 0.5) {
        const need = dragon.stanceNeed(frames, clawTargets);
        if (need > 0) dragon.setStance(need / 0.82);
      }
    }
    const aim = choreo.headAim(t, frames[0].position, headQuat);
    dragon.update(frames, {
      jawOpen: choreo.jawOpen(t),
      throatGlow: choreo.throatGlow(t),
      legReach: reach,
      legTargets: clawTargets,
      time: t,
      swim,
      headAim: aim,
    });
    dragon.syncMatrices();

    // 8) Nhịp kể chuyện: chữ, va chạm, biểu ngữ.
    if (!titleShown && t >= TIMELINE.titleAt) {
      titleShown = true;
      overlay.revealTitle();
    }
    if (!impacted && t >= TIMELINE.contactAt) {
      impacted = true;
      overlay.impact();
      fireworks.explode(TMP_A.copy(choreo.anchor).add(TMP_B.set(0, 1.2, -1.6)), false);
    }
    if (!bannerShown && t >= TIMELINE.bannerAt) {
      bannerShown = true;
      overlay.revealBanner(options.detail);
    }

    // 9) Lửa phun bám đúng khóe miệng và hướng đầu đang nhìn.
    const fire = choreo.fireIntensity(t);
    if (fire > 0.001) {
      dragon.mouthPoint(TMP_A);
      dragon.mouthDirection(TMP_B);
      flame.emit(TMP_A, TMP_B, fire, dt, t);
    } else {
      flame.idle();
    }
    flame.update(dt);

    // 10) Pháo hoa + mây trôi + ánh sáng theo nhịp.
    fireworks.ambient(dt, t);
    fireworks.update(dt, t);
    for (let i = 0; i < clouds.length; i += 1) {
      clouds[i].position.x += dt * (0.16 + i * 0.03);
      if (clouds[i].position.x > 20) clouds[i].position.x = -20;
    }
    rim.intensity = 1.55 + 0.5 * Math.sin(t * 2.2);
  };

  const step = (now: number) => {
    if (stopped || paused) return;
    if (!startedAt) {
      startedAt = now;
      last = now;
    }
    const rawDt = (now - last) / 1000;
    const dt = Math.min(0.05, Math.max(0.001, rawDt));
    last = now;
    const t = (now - startedAt) / 1000;
    frameEma = frameEma * 0.9 + rawDt * 1000 * 0.1;
    if (frameEma > 24 && dprCap > 0.8) {
      slowMs += rawDt * 1000;
      if (slowMs > 500) {
        slowMs = 0;
        dprCap = Math.max(0.8, dprCap - 0.25);
        renderer.setPixelRatio(dprCap);
        composer.setPixelRatio(dprCap);
      }
    } else {
      slowMs = 0;
    }

    poseAt(t, dt);
    syncParticleScale();
    composer.render();

    if (t < LIFE_MS / 1000) {
      raf = requestAnimationFrame(step);
    } else {
      finish();
    }
  };

  /**
   * Tiến mô phỏng tới đúng một thời điểm rồi mới vẽ một khung. Dùng cho
   * kiểm thử tạo bằng chứng từng khoảnh khắc và cho ảnh tĩnh
   * prefers-reduced-motion: cùng đường dựng hình với vòng lặp thật.
   * Chỉ đi tới được (không tua ngược).
   */
  const seekTo = (target: number) => {
    const dt = 1 / 60;
    const steps = Math.min(1400, Math.max(0, Math.ceil((target - simTime) / dt)));
    for (let i = 0; i < steps; i += 1) poseAt(simTime + dt, dt);
    poseAt(target, dt);
    syncParticleScale();
    composer.render();
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
    // Gỡ hẳn overlay khỏi DOM: nếu còn sót nút, lần bán xe sau sẽ bị chặn
    // bởi chốt chống chồng overlay và nhân viên không còn màn chúc mừng.
    overlay.destroy();
    dragon.dispose();
    fireworks.dispose();
    flame.dispose();
    for (const m of clouds) {
      m.geometry.dispose();
      (m.material as MeshBasicMaterial).dispose();
    }
    cloudTexture.dispose();
    skyTexture.dispose();
    envTexture.dispose();
    roomEnv.dispose();
    pmrem.dispose();
    composer.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };

  let resumeAt = 0;
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      resumeAt = performance.now();
    } else if (!stopped) {
      // Cộng dồn thời gian ẩn để đồng hồ cảnh không nhảy cóc khi quay lại.
      if (resumeAt) {
        const gap = performance.now() - resumeAt;
        startedAt += gap;
        last = performance.now();
      }
      raf = requestAnimationFrame(step);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  /** Kết thúc sớm có kiểm soát: dừng máy, nhường điều hướng cho caller. */
  const finish = () => {
    if (stopped) return;
    overlay.beginExit();
    window.setTimeout(cleanup, FADE_MS);
    options.onExit();
  };

  /** Khung tĩnh cho prefers-reduced-motion: dựng đúng thế chiến thắng, không chạy loop. */
  const renderStaticFrame = () => {
    seekTo(9.2);
    fireworks.explode(new Vector3(-4, 4, -8), true);
    fireworks.update(0.35, 0.4);
    syncParticleScale();
    composer.render();
  };

  /**
   * Đồng hồ gỡ cảnh theo giờ thật do celebrate.ts cài (dây an toàn khi vòng
   * lặp chết giữa chừng). Khi người kiểm thử dừng vòng lặp để tua từng giây
   * chụp bằng chứng, đồng hồ này phải được tháo ngòi — GPU phần mềm vẽ một
   * khung mất cả giây, để nó đếm tiếp thì cảnh bị cắt trước khi chụp xong.
   */
  let disarmSafetyTimer: (() => void) | null = null;

  return {
    element: overlay.root,
    tier,
    start() {
      document.body.appendChild(overlay.root);
      if (options.reducedMotion) {
        renderStaticFrame();
        return;
      }
      raf = requestAnimationFrame(step);
    },
    /** Bấm là khép màn — an toàn, không để lại timer hay GPU lease. */
    dismiss: finish,
    dispose: cleanup,
    /**
     * Cửa chẩn đoán phục vụ kiểm thử hình ảnh: tua tới đúng giây của đòn
     * múa và bật/tắt từng lớp render. Không vòng nào gọi từ luồng bán hàng
     * thật; celebrate.ts chỉ gắn nó lên window khi chạy dev server.
     */
    debug: {
      seekTo,
      /** celebrate.ts gửi callback gỡ đồng hồ an toàn vào đây (dev only). */
      holdSafety(disarm: () => void) {
        disarmSafetyTimer = disarm;
      },
      /** Dừng vòng lặp để giữ nguyên một khung đã tua phục vụ chụp ảnh. */
      pause() {
        paused = true;
        cancelAnimationFrame(raf);
        disarmSafetyTimer?.();
        disarmSafetyTimer = null;
      },
      resume() {
        if (stopped || !paused) return;
        paused = false;
        const gap = performance.now() - last;
        startedAt += gap;
        last = performance.now();
        raf = requestAnimationFrame(step);
      },
      get time() {
        return simTime;
      },
      setBloom(on: boolean) {
        if (bloom) bloom.enabled = on;
      },
      setClouds(on: boolean) {
        cloudGroup.visible = on;
      },
      setExposure(v: number) {
        renderer.toneMappingExposure = v;
      },
      /**
       * Đặt máy quay lên một quỹ đạo quanh neo sân khấu rồi vẽ lại NGAY.
       * Chỉ dùng cho bảng nhân vật nhiều góc (character sheet): tư thế đã
       * đóng băng nên không có poseAt nào chạy, và neo cũng đã khoá từ nhịp
       * đáp — quay ống kính không làm long chân khỏi mặt chữ.
       */
      orbit(deg: number, radius = 16.6, y = 0.35) {
        const r = (deg * Math.PI) / 180;
        camera.position.set(
          choreo.anchor.x + Math.sin(r) * radius,
          y,
          choreo.anchor.z + Math.cos(r) * radius,
        );
        camera.lookAt(choreo.anchor.x, choreo.anchor.y + 1.3, choreo.anchor.z);
        camera.updateMatrixWorld();
        syncParticleScale();
        composer.render();
      },
      /** Đếm đốt sống thành NaN — lỗi hình học là lỗi im lặng dễ nhất. */
      invalidBones: () => {
        let bad = 0;
        for (const f of frames) {
          if (
            !Number.isFinite(f.position.x + f.position.y + f.position.z) ||
            !Number.isFinite(
              f.quaternion.x + f.quaternion.y + f.quaternion.z + f.quaternion.w,
            )
          ) {
            bad += 1;
          }
        }
        return bad;
      },
      /**
       * Độ lệch giữa đầu rồng ĐÃ RENDER (headAnchor trong thế giới thật) và
       * vị trí đầu mà biên đạo yêu cầu. Một pipeline khớp nối đúng thì con
       * số này phải xấp xỉ 0 mọi khung hình; nó to lên nghĩa là đầu đã
       * tách khỏi chuỗi thân mà mắt thường không thấy ngay.
       */
      headGap() {
        dragon.syncMatrices();
        choreo.headPosition(simTime, headPos);
        return {
          gap: dragon.headPosition(TMP_A).distanceTo(headPos),
          rendered: dragon.headPosition(TMP_A).toArray(),
          wanted: headPos.toArray(),
        };
      },
      /**
       * Bối cảnh WebGL của sân khấu này còn sống không. Trình duyệt chỉ cho
       * mở chừng 16 context cùng lúc, nên một màn chúc mừng rò rỉ context thì
       * lần bán xe thứ bảy sẽ âm thầm rơi về pháo hoa 2D. Đo thẳng trạng thái
       * context biến giả thuyết "dọn GPU sạch" thành số đọc được.
       */
      glLost: () => renderer.getContext().isContextLost(),
      /**
       * Số liệu hiệu năng ĐO TRỰC TIẾP trong máy đang chạy, phục vụ bản
       * báo cáo kỹ thuật: tải vẽ của GPU (draw call, tam giác, bộ nhớ GPU)
       * và chi phí CPU của một khung dựng hình (rig + hạt + nhịp kể), tách
       * riêng phần vẽ ra để biết còn bao nhiêu hạn ngạch trong 16,6ms.
       * Lưu ý: chạy xong là hạt lửa vừa được phát thêm ~50 khung — chỉ dùng
       * lúc đo, không dùng giữa lúc chụp bằng chứng.
       *
       * Draw call phải đo bằng một lần vẽ CẢNH THUẦN, không đọc
       * renderer.info sau composer.render(): pass cuối của EffectComposer
       * là một fullscreen quad và autoReset xoá số liệu của RenderPass
       * trước đó, nên đọc sau cùng luôn trả về draws=1 tris=1 — đó là số
       * của quad hậu kỳ, không phải của cảnh rồng.
       */
      stats() {
        const samples: number[] = [];
        for (let round = 0; round < 5; round += 1) {
          const t0 = performance.now();
          for (let i = 0; i < 10; i += 1) poseAt(simTime + i * 0.001, 1 / 60);
          samples.push((performance.now() - t0) / 10);
        }
        samples.sort((a, b) => a - b);
        const info = renderer.info;
        info.reset();
        renderer.render(scene, camera);
        const scenePass = { calls: info.render.calls, triangles: info.render.triangles };
        // Vẽ lại nguyên pipeline để màn hình trở về đúng khung hình hậu kỳ.
        composer.render();
        // Đếm geometry duy nhất mà scene graph ĐANG giữ, để phân biệt
        // "tải chậm" với "rò rỉ": nếu tổng số này không đổi theo thời gian
        // mà info.memory.geometries tăng dần, đó chỉ là bộ đệm thuộc tính
        // được upload khi vật thể lần đầu đi vào khung hình.
        const unique = new Set<string>();
        scene.traverse((o) => {
          const g = (o as Mesh).geometry;
          if (g) unique.add(g.uuid);
        });
        return {
          drawCalls: scenePass.calls,
          triangles: scenePass.triangles,
          geometries: info.memory.geometries,
          geometryTotal: unique.size,
          textures: info.memory.textures,
          programs: info.programs?.length ?? 0,
          fireLive: flame.fire.liveCount,
          emberLive: flame.sparks.liveCount,
          fireworkLive: fireworks.particles.liveCount,
          bones: BONES,
          dpr: dprCap,
          tier,
          rigMs: samples[Math.floor(samples.length / 2)],
        };
      },
    },
    get threeRevision() {
      return REVISION;
    },
  };
}
