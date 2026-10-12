// Rồng vàng đế chế — nhân vật 3D thủ tục, rig xương thật, biến dạng thật.
//
// Vì môi trường này không có Blender, không có thư viện asset và không được
// mua bản quyền, nhân vật được Dựng bằng giải thuật: một SkinnedMesh với
// chuỗi 46 xương, trọng lượng da tính theo cung thân, đầu rồng lắp ghép
// giải phẫu (hộp sọ, quai hàm khớp quay, răng, mắt hổ phách phát sáng, sừng
// phân nhánh bằng ống theo đường cong, bờm, râu động), bốn chân IK hai
// khớp với móng vuốt, và màng gai lưng dựng lại mỗi khung hình theo cột
// sống. Đây là nhân vật thật — thân uốn, xoắn, nghển cổ, há miệng — chứ
// không phải một tấm ảnh di chuyển theo hình chữ S.

import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Skeleton,
  SphereGeometry,
  Texture,
  TubeGeometry,
  Vector2,
  Vector3,
} from "three";

import { bodyRadius, type SpineFrame } from "./spine";

export type DragonQuality = {
  rings: number;
  radial: number;
  whiskerEvery: number;
};

export type DragonState = {
  /** 0 = ngậm, 1 = há tối đa. */
  jawOpen: number;
  /** Cường độ lửa bén trong họng (0..1). */
  throatGlow: number;
  /** 0 = co khi bay, 1 = chống hết lên mặt chữ. */
  legReach: number;
  /** Mục tiêu thế giới cho 4 đầu gối vuốt [trái trước, phải trước, trái sau, phải sau]. */
  legTargets: (Vector3 | null)[];
  /** Thời gian tổng (giây) cho sóng bờm/râu. */
  time: number;
  /** Biên độ sóng thân (0..1) — giảm khi đáp xuống để mình ổn định. */
  swim: number;
  /**
   * Hướng đầu độc lập với tiếp tuyến cổ (ngẩng nhìn camera, cúi khi đáp).
   * null = đầu bám theo hướng bay tự nhiên.
   */
  headAim?: Quaternion | null;
};

/**
 * Khoảng cách đốt sống. 45 × 0.38 = 17.1 đơn vị thế giới: thân phải đủ dài
 * so với khối chữ khổng lồ (chiều ngang chữ ~22 đơn vị) thì một vòng cuộn
 * mới chiếm trọn khung hình; biên đạo chuẩn hoá tạo hình đậu đúng theo số
 * này nên đổi ở đây là đổi cả nhân vật lẫn tư thế, không lệch tiếp xúc.
 *
 * HAI SỐ NÀY LÀ SỰ THẬT DUY NHẤT: stage.ts phải nạp đúng BONES/SPACING này
 * cho bộ giải khớp và cho biên đạo. Da (bind pose) dựng theo SPACING mà
 * chuỗi khớp chạy theo khoảng cách khác thì thân bị nén/giãn đều đặn cả
 * con rồng — vảy chồng lên nhau, đuôi non đốt, và chiều dài tạo hình đậu
 * không khớp với người thật.
 */
export const SPACING = 0.38;
export const BONES = 46;
const BODY_LEN = (BONES - 1) * SPACING;
const BASE_RADIUS = 0.5;
/** Đầu rồng to gấp rưỡi bề dày thân — chuẩn nhận diện của rồng đế chế. */
const HEAD_SCALE = 1.5;

const GOLD = { color: 0xffffff, metalness: 0.62, roughness: 1 };
const HORN = { color: 0xf6e6c2, metalness: 0.28, roughness: 0.4 };
const MANE = { color: 0xffd264, metalness: 0.5, roughness: 0.46 };
const CREST = { color: 0xe06a1e, metalness: 0.35, roughness: 0.55 };

// Trục và vector dùng chung cho IK: dựng tạm Vector3 trong vòng lặp 60fps
// chỉ tổ gây áp lực cho bộ thu gom rác mà không mang lại lợi ích nào.
const AXIS_Z = new Vector3(0, 0, 1);
const AXIS_Y = new Vector3(0, 1, 0);
const TMP_Q = new Quaternion();
const TMP_BQ = new Quaternion();
const TMP_BV = new Vector3();
const TMP_W = new Vector3();

export class Dragon {
  readonly group = new Group();
  /** Gốc cổ – đầu, bờm, râu gắn vào đây nên tự theo động tác ngẩng. */
  private readonly headAnchor = new Group();
  private readonly bones: Bone[] = [];
  private readonly body!: SkinnedMesh;
  private jaw!: Group;
  private throat!: Mesh;
  private readonly mane: Object3D[] = [];
  private whiskerL!: Group;
  private whiskerR!: Group;
  private readonly legs: {
    upper: Mesh;
    lower: Mesh;
    knee: Mesh;
    foot: Group;
    hipIndex: number;
    side: number;
    front: boolean;
    l1: number;
    l2: number;
  }[] = [];
  private readonly crest: Mesh[] = [];
  private readonly crestAt: number[] = [];
  private readonly materials: MeshStandardMaterial[] = [];
  private readonly textures: Texture[] = [];
  private readonly quality: DragonQuality;
  private whiskerTick = 0;
  /** Cỡ chân so với thân, đồng bộ với tỷ lệ rồng–chữ của biên đạo. */
  private stance = 1;

  constructor(
    quality: DragonQuality,
    maps: { map: Texture; normalMap: Texture; roughnessMap: Texture },
  ) {
    this.quality = quality;
    for (const t of Object.values(maps)) this.textures.push(t);
    const scaleMat = new MeshStandardMaterial({
      color: GOLD.color,
      metalness: GOLD.metalness,
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      normalScale: new Vector2(1.15, 1.15),
      envMapIntensity: 1.35,
    });
    scaleMat.roughness = 0.55;
    this.materials.push(scaleMat);
    this.body = this.buildBody(scaleMat);

    for (let i = 0; i < BONES; i += 1) {
      const bone = new Bone();
      bone.name = `spine_${i}`;
      if (i === 0) bone.position.set(0, 0, 0);
      else {
        bone.position.set(0, 0, -SPACING);
        this.bones[i - 1].add(bone);
      }
      this.bones.push(bone);
    }
    this.body.add(this.bones[0]);
    this.body.bind(new Skeleton(this.bones));
    this.group.add(this.body);

    this.headAnchor.position.set(0, 0, 0);
    // Đầu phải là chi tiết ĐỌC RA trước tiên của một con rồng đế chế: to,
    // có góc cạnh, sừng bờm râu rõ ràng. Ở cỡ 1.0 đầu chỉ bằng một đốt
    // thân dày, nhân vật thành con rắn có đuôi nhọt.
    this.headAnchor.scale.setScalar(HEAD_SCALE);
    this.group.add(this.headAnchor);
    this.buildHead(scaleMat);
    this.buildCrest();
    this.buildLegs(scaleMat);
  }

  // ---------------------------------------------------------------- thân

  private buildBody(material: MeshStandardMaterial): SkinnedMesh {
    const rings = this.quality.rings;
    const radial = this.quality.radial;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const skinIdx: number[] = [];
    const skinWt: number[] = [];

    for (let r = 0; r <= rings; r += 1) {
      const t = r / rings;
      const radius = bodyRadius(t, BASE_RADIUS);
      const z = -t * BODY_LEN;
      for (let s = 0; s <= radial; s += 1) {
        const a = (s / radial) * Math.PI * 2;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        // Tiết diện bầu dục hơi dẹt dưới bụng, lưng nhô sống nhẹ.
        const rx = radius * (1 + 0.06 * Math.cos(a) * 0);
        const ry = radius * 0.88 + (sin > 0 ? radius * 0.09 : 0);
        positions.push(cos * rx, sin * ry, z);
        uvs.push(t * 9, (s / radial) * 1.4);
        // Trọng lượng da: nội suy tuyến tính giữa hai xương gần nhất.
        const b = t * (BONES - 1);
        const i0 = Math.min(BONES - 1, Math.floor(b));
        const i1 = Math.min(BONES - 1, i0 + 1);
        const f = b - i0;
        skinIdx.push(i0, i1, 0, 0);
        skinWt.push(1 - f, f, 0, 0);
      }
    }
    const stride = radial + 1;
    for (let r = 0; r < rings; r += 1) {
      for (let s = 0; s < radial; s += 1) {
        const a = r * stride + s;
        const b = a + stride;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
    geo.setAttribute("skinIndex", new BufferAttribute(new Uint16Array(skinIdx), 4));
    geo.setAttribute("skinWeight", new BufferAttribute(new Float32Array(skinWt), 4));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new SkinnedMesh(geo, material);
    mesh.frustumCulled = false;
    return mesh;
  }

  // ---------------------------------------------------------------- đầu

  private buildHead(material: MeshStandardMaterial) {
    const boneMat = new MeshStandardMaterial({
      color: HORN.color,
      metalness: HORN.metalness,
      roughness: HORN.roughness,
    });
    const maneMat = new MeshStandardMaterial({
      color: MANE.color,
      metalness: MANE.metalness,
      roughness: MANE.roughness,
      emissive: 0x5c2a04,
      emissiveIntensity: 0.7,
    });
    this.materials.push(boneMat, maneMat);

    const skull = new Mesh(new SphereGeometry(0.5, 26, 20), material);
    skull.scale.set(0.98, 0.86, 1.24);
    skull.position.set(0, 0.06, 0.1);
    this.headAnchor.add(skull);

    // Mái tóc bờm phía sau hộp sọ: 7 dải dẹt uốn gập sóng theo thời gian.
    for (let i = 0; i < 7; i += 1) {
      const spike = new Mesh(new ConeGeometry(0.13, 0.95, 6), maneMat);
      const spread = (i / 6 - 0.5) * 1.5;
      spike.position.set(Math.sin(spread) * 0.34, 0.3 - Math.abs(spread) * 0.16, -0.36);
      spike.rotation.set(-1.9 + Math.abs(spread) * 0.2, spread * 0.7, spread * 0.5);
      spike.scale.set(1, 1, 0.35);
      this.headAnchor.add(spike);
      this.mane.push(spike);
    }

    // Gờ má + xương đỉnh: khối đầu có góc cạnh, không phải quả bóng.
    for (const s of [-1, 1]) {
      const cheek = new Mesh(new SphereGeometry(0.26, 16, 12), material);
      cheek.scale.set(0.5, 0.42, 1.15);
      cheek.position.set(s * 0.3, 0.02, 0.26);
      this.headAnchor.add(cheek);
      const ridge = new Mesh(new BoxGeometry(0.1, 0.16, 0.62), material);
      ridge.position.set(s * 0.26, 0.3, 0.16);
      ridge.rotation.z = s * 0.22;
      this.headAnchor.add(ridge);
    }

    // mõm trên: khối thuôn dài, đầu mũi nở.
    const snout = new Mesh(new SphereGeometry(0.3, 20, 14), material);
    snout.scale.set(0.92, 0.62, 1.75);
    snout.position.set(0, -0.06, 0.78);
    this.headAnchor.add(snout);
    const nose = new Mesh(new SphereGeometry(0.17, 14, 10), material);
    nose.scale.set(1.25, 0.72, 1);
    nose.position.set(0, -0.02, 1.26);
    this.headAnchor.add(nose);
    for (const s of [-1, 1]) {
      const nostril = new Mesh(new SphereGeometry(0.045, 8, 6), boneMat);
      nostril.position.set(s * 0.1, 0.05, 1.36);
      this.headAnchor.add(nostril);
    }

    // Hàm dưới khớp quay – há ngậm thật khi phun lửa.
    this.jaw = new Group();
    this.jaw.position.set(0, -0.16, 0.34);
    const jawMesh = new Mesh(new SphereGeometry(0.27, 18, 12), material);
    jawMesh.scale.set(0.9, 0.44, 1.7);
    jawMesh.position.set(0, -0.03, 0.46);
    this.jaw.add(jawMesh);
    for (const s of [-1, 1]) {
      const jawCheek = new Mesh(new SphereGeometry(0.16, 10, 8), material);
      jawCheek.scale.set(0.5, 0.5, 1.5);
      jawCheek.position.set(s * 0.17, 0.02, 0.2);
      this.jaw.add(jawCheek);
    }
    this.headAnchor.add(this.jaw);

    // Răng: hàm trên chúc xuống, hàm dưới vểnh lên.
    const toothGeo = new ConeGeometry(0.032, 0.16, 6);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 5; i += 1) {
        const z = 0.55 + i * 0.18;
        const upper = new Mesh(toothGeo, boneMat);
        upper.position.set(s * (0.17 - i * 0.012), -0.19 + i * 0.012, z);
        upper.rotation.x = Math.PI;
        this.headAnchor.add(upper);
        const lower = new Mesh(toothGeo, boneMat);
        lower.position.set(s * (0.15 - i * 0.01), -0.2, z - 0.02);
        this.jaw.add(lower);
      }
    }

    // Buồng lửa trong họng: phát sáng dần trước khi phun.
    this.throat = new Mesh(
      new SphereGeometry(0.2, 12, 10),
      new MeshStandardMaterial({
        color: 0xff7a18,
        emissive: 0xff5a00,
        emissiveIntensity: 0,
        roughness: 1,
      }),
    );
    this.throat.position.set(0, -0.13, 0.5);
    this.throat.visible = false;
    this.headAnchor.add(this.throat);

    // Mắt hổ phách: lòng trắng ấm, đồng tử dọc, mày nổi khối – thần thái
    // uy nghi chứ không phải mắt tròn to ngơ ngác.
    const eyeWhite = new MeshStandardMaterial({
      color: 0xffd98a,
      emissive: 0xff9a1f,
      emissiveIntensity: 1.5,
      roughness: 0.25,
    });
    const pupil = new MeshStandardMaterial({ color: 0x160a02, roughness: 0.15 });
    this.materials.push(eyeWhite, pupil);
    for (const s of [-1, 1]) {
      const ball = new Mesh(new SphereGeometry(0.115, 16, 12), eyeWhite);
      ball.scale.set(1, 1.05, 0.85);
      ball.position.set(s * 0.3, 0.2, 0.44);
      this.headAnchor.add(ball);
      const slit = new Mesh(new SphereGeometry(0.062, 10, 8), pupil);
      slit.scale.set(0.34, 1.1, 0.5);
      slit.position.set(s * 0.335, 0.205, 0.53);
      this.headAnchor.add(slit);
      const brow = new Mesh(new BoxGeometry(0.3, 0.08, 0.2), material);
      brow.position.set(s * 0.28, 0.33, 0.42);
      brow.rotation.set(-0.25, 0, s * 0.32);
      this.headAnchor.add(brow);
    }

    // Sừng chính phân nhánh + tai tơ: ống chạy theo Catmull-Rom.
    for (const s of [-1, 1]) {
      const main = new CatmullRomCurve3([
        new Vector3(s * 0.18, 0.36, -0.06),
        new Vector3(s * 0.3, 0.72, -0.42),
        new Vector3(s * 0.26, 1.02, -1.02),
        new Vector3(s * 0.08, 1.16, -1.68),
      ]);
      const horn = new Mesh(new TubeGeometry(main, 18, 0.075, 8), boneMat);
      this.headAnchor.add(horn);
      const tip = new Mesh(new ConeGeometry(0.075, 0.3, 8), boneMat);
      tip.position.copy(main.getPoint(1));
      tip.quaternion.setFromUnitVectors(
        new Vector3(0, 1, 0),
        main.getTangent(1).normalize(),
      );
      this.headAnchor.add(tip);
      const branch = new CatmullRomCurve3([
        new Vector3(s * 0.28, 0.78, -0.5),
        new Vector3(s * 0.52, 0.98, -0.78),
        new Vector3(s * 0.6, 1.16, -1.2),
      ]);
      this.headAnchor.add(new Mesh(new TubeGeometry(branch, 12, 0.045, 7), boneMat));
      const antler = new CatmullRomCurve3([
        new Vector3(s * 0.2, 0.42, 0.02),
        new Vector3(s * 0.44, 0.62, -0.1),
        new Vector3(s * 0.5, 0.86, -0.34),
      ]);
      this.headAnchor.add(new Mesh(new TubeGeometry(antler, 10, 0.03, 6), boneMat));
      // Vây tai tơ sau khóe mắt.
      const ear = new Mesh(new ConeGeometry(0.19, 0.5, 4), new MeshStandardMaterial({
        color: CREST.color,
        metalness: CREST.metalness,
        roughness: CREST.roughness,
        side: DoubleSide,
        transparent: true,
        opacity: 0.94,
      }));
      this.materials.push(ear.material as MeshStandardMaterial);
      ear.position.set(s * 0.42, 0.24, -0.16);
      ear.rotation.set(-1.25, 0, s * 0.9);
      ear.scale.set(1, 1, 0.22);
      this.headAnchor.add(ear);
      this.mane.push(ear);
    }

    // Râu rồng: hai ống động dựng lại mỗi vài khung hình, bay phần phật.
    this.whiskerL = new Group();
    this.whiskerR = new Group();
    this.headAnchor.add(this.whiskerL, this.whiskerR);
    this.rebuildWhiskers(0);
  }

  private whiskerMat?: MeshStandardMaterial;

  private rebuildWhiskers(time: number) {
    const mat =
      this.whiskerMat ??
      (this.whiskerMat = new MeshStandardMaterial({
        color: 0xffe6a8,
        metalness: 0.4,
        roughness: 0.5,
        emissive: 0x3a1c04,
      }));
    for (const [group, s] of [
      [this.whiskerL, -1],
      [this.whiskerR, 1],
    ] as const) {
      group.clear();
      const sway = Math.sin(time * 2.1 + s * 1.6) * 0.16;
      const sway2 = Math.cos(time * 1.7 + s * 0.8) * 0.2;
      const curve = new CatmullRomCurve3([
        new Vector3(s * 0.2, -0.18, 1.16),
        new Vector3(s * 0.52, -0.34 + sway, 1.66),
        new Vector3(s * 0.86, -0.06 + sway2, 1.5),
        new Vector3(s * 1.0, 0.42 + sway, 0.94),
      ]);
      group.add(new Mesh(new TubeGeometry(curve, 20, 0.026, 6), mat));
      // Râu phụ ngắn dưới cằm.
      const short = new CatmullRomCurve3([
        new Vector3(s * 0.12, -0.26, 0.62),
        new Vector3(s * 0.26, -0.52 + sway2 * 0.5, 0.5),
        new Vector3(s * 0.3, -0.74 + sway, 0.24),
      ]);
      group.add(new Mesh(new TubeGeometry(short, 10, 0.02, 5), mat));
    }
  }

  // ------------------------------------------------------------- gai lưng

  /**
   * Lưng rồng đế chế = một dãy vây lưỡi liềm dọc cột sống. Dựng bằng lưới
   * động (tái tính vertex mỗi khung hình) từng cho ra một "tấm ván" cam
   * thẳng đứng lệch khỏi thân; ở đây mỗi vây là một lưới cứng dùng chung,
   * chỉ đổi vị trí/nghiêng/thước theo đốt sống — bám sát cột sống tuyệt
   * đối, rẻ hơn nhiều và không bao giờ tách khỏi mình.
   */
  private buildCrest() {
    const geo = new ConeGeometry(1, 1, 4);
    geo.translate(0, 0.5, 0); // gốc vây nằm trên sống lưng
    const mat = new MeshStandardMaterial({
      color: CREST.color,
      emissive: 0x4d1404,
      emissiveIntensity: 0.55,
      metalness: CREST.metalness,
      roughness: CREST.roughness,
      side: DoubleSide,
    });
    this.materials.push(mat);
    const count = 26;
    for (let i = 0; i < count; i += 1) {
      const fin = new Mesh(geo, mat);
      fin.frustumCulled = false;
      this.group.add(fin);
      this.crest.push(fin);
      // Phân bố vây theo chiều dài thân, dồn dập ở cổ để đọc là gai, thưa
      // dần về đuôi nơi thân chỉ còn một đường fin thấp.
      this.crestAt.push(Math.pow(i / (count - 1), 0.92) * 0.94);
    }
  }

  // ----------------------------------------------------------------- chân

  private buildLegs(material: MeshStandardMaterial) {
    const limbMat = material;
    const clawMat = new MeshStandardMaterial({
      color: HORN.color,
      metalness: HORN.metalness,
      roughness: HORN.roughness,
    });
    this.materials.push(clawMat);
    const upperGeo = new CapsuleGeometry(1, 1, 4, 10);
    // Vị trí chân tính theo ĐỐT SỐNG theo tỷ lệ thân: 46 đốt × 0.38 = 17.1
    // chiều dài. Đốt 7 ở 16% (ngực) và đốt 17 ở 38% (bụng sau) — đúng nơi
    // đường cong đậu hạ thấp nhất, nên hông ngồi trên hai điểm tì chứ không
    // mọc sau gáy.
    const joints = [
      { index: 7, side: -1, front: true },
      { index: 7, side: 1, front: true },
      { index: 17, side: -1, front: false },
      { index: 17, side: 1, front: false },
    ];
    for (const j of joints) {
      const upper = new Mesh(upperGeo, limbMat);
      const lower = new Mesh(upperGeo, limbMat);
      const knee = new Mesh(new SphereGeometry(1, 10, 8), limbMat);
      const foot = new Group();
      // Bàn chân: 3 móng vuốt chĩa trước-xuống + đệm gan.
      for (let c = 0; c < 3; c += 1) {
        const claw = new Mesh(new ConeGeometry(0.07, 0.42, 7), clawMat);
        claw.rotation.x = -Math.PI * 0.72;
        claw.position.set((c - 1) * 0.14, -0.02, 0.16);
        claw.rotation.z = (c - 1) * 0.22;
        foot.add(claw);
      }
      const pad = new Mesh(new SphereGeometry(0.16, 10, 8), limbMat);
      pad.scale.set(1.1, 0.55, 1.3);
      foot.add(pad);
      this.group.add(upper, lower, knee, foot);
      this.legs.push({
        upper,
        lower,
        knee,
        foot,
        hipIndex: j.index,
        side: j.side,
        front: j.front,
        l1: j.front ? 0.7 : 0.68,
        l2: j.front ? 0.66 : 0.62,
      });
    }
  }

  /**
   * Đồng bộ cỡ chân khi rồng đứng trước chữ to/nhỏ khác nhau ở các khổ màn
   * hình: chân và tầm với giãn theo, nếu không thế đứng sẽ vẹo dần khi
   * nhân vật bị tỷ lệ sân khấu kéo đi.
   */
  setStance(scale: number) {
    this.stance = Math.min(1.35, Math.max(0.8, scale));
  }

  /**
   * Tự cân thế đứng: đo xem chân nào phải với xa nhất so với tầm với chuẩn
   * của chính nó (tỷ lệ 1.0 = duỗi hết cỡ, gãy khớp). Biên đạo dùng kết quả
   * này để chọn `stance`, nhờ vậy móng luôn chạm mặt chữ ở mọi khổ màn hình
   * thay vì lơ lửng rồi bị kéo căng thành cây sào — GATE C không được phép
   * trông chờ vào một con số đo sẵn trên đúng một màn hình.
   */
  stanceNeed(frames: SpineFrame[], targets: (Vector3 | null)[]): number {
    let worst = 0;
    for (let i = 0; i < this.legs.length; i += 1) {
      const leg = this.legs[i];
      const goal = targets[i];
      if (!goal) continue;
      const f = frames[Math.min(leg.hipIndex, frames.length - 1)];
      const hip = this.hipOf(f, leg.side, this.tmpHip);
      const reach = (leg.l1 + leg.l2) * 0.97;
      worst = Math.max(worst, hip.distanceTo(goal) / reach);
    }
    return worst;
  }

  // ------------------------------------------------------------- cập nhật

  /** Ghi chuyển động: khung xương thân, đầu, hàm, bờm, râu, chân, gai lưng. */
  update(frames: SpineFrame[], state: DragonState) {
    const q = TMP_BQ;
    const v = TMP_BV;
    // 0) Bán kính thân theo biên dạng – gai lưng và hông chân đọc từ đây.
    for (let i = 0; i < BONES; i += 1) {
      frames[i].radius = bodyRadius(i / (BONES - 1), BASE_RADIUS);
    }
    // 1) Xương thân: biến đổi cục bộ = nghịch đảo khung xương cha × khung
    //    hình thế giới mong muốn → thân uốn/lăn đúng theo chuỗi điểm.
    for (let i = 0; i < BONES; i += 1) {
      const bone = this.bones[i];
      const f = frames[i];
      if (i === 0) {
        bone.position.copy(f.position);
        bone.quaternion.copy(f.quaternion);
      } else {
        const parent = frames[i - 1];
        q.copy(parent.quaternion).invert();
        bone.position.copy(v.subVectors(f.position, parent.position).applyQuaternion(q));
        bone.quaternion.copy(q).multiply(f.quaternion);
      }
    }
    // 2) Đầu: bám gốc cổ nhưng có nhịp ngẩng/cúi riêng (độc lập với tiếp
    //    tuyến cổ) — đây là thứ bán "thần thái" của nhân vật.
    const head = frames[0];
    this.headAnchor.position.copy(head.position).addScaledVector(head.forward, 0.1);
    if (state.headAim) {
      this.headAnchor.quaternion.copy(head.quaternion).slerp(state.headAim, 0.82);
    } else {
      this.headAnchor.quaternion.copy(head.quaternion);
    }
    // 3) Hàm.
    this.jaw.rotation.x = state.jawOpen * 0.72;
    const throatMat = this.throat.material as MeshStandardMaterial;
    // 7x cùng bloom biến cả đầu rồng thành một vệt trắng loá — che mất chính
    // thứ đắt giá nhất của nhân vật (mắt, sừng, hàm). Họng phải là một lò
    // rèn sáng rực trong khoang miệng, không phải một bóng đèn halogen.
    throatMat.emissiveIntensity = state.throatGlow * 4.6;
    this.throat.visible = state.throatGlow > 0.02;
    this.throat.scale.setScalar(0.7 + state.throatGlow * 0.5);
    // 4) Bờm + tai tơ: lắc theo thời gian và theo gia tốc thân.
    for (let i = 0; i < this.mane.length; i += 1) {
      const m = this.mane[i];
      m.rotation.x += Math.sin(state.time * 3.1 + i * 0.9) * 0.05 * state.swim;
      m.rotation.z += Math.cos(state.time * 2.4 + i * 1.3) * 0.04 * state.swim;
    }
    // 5) Râu: dựng lại định kỳ (tiết kiệm GC) – bay trong gió khi lượn.
    this.whiskerTick += 1;
    if (this.whiskerTick % this.quality.whiskerEvery === 0) {
      this.rebuildWhiskers(state.time);
    }
    // 6) Gai lưng dựng lại theo cột sống mỗi khung hình.
    this.updateCrest(frames, state.time);
    // 7) Bốn chân IK.
    this.updateLegs(frames, state);
  }

  private updateCrest(frames: SpineFrame[], time: number) {
    const up = this.tmpUp.set(0, 1, 0);
    for (let i = 0; i < this.crest.length; i += 1) {
      const fin = this.crest[i];
      const s = this.crestAt[i];
      const fi = Math.min(frames.length - 1, Math.round(s * (frames.length - 1)));
      const f = frames[fi];
      // Cao độ vây: thấp ở cổ, đỉnh giữa lưng, nhọn dần về chóp đuôi.
      const h =
        f.radius *
        (0.42 + 1.35 * Math.sin(Math.PI * Math.min(1, s * 1.06))) *
        (1 + 0.07 * Math.sin(time * 5.2 - i * 0.55));
      fin.position
        .copy(f.position)
        .addScaledVector(f.up, f.radius * 0.62)
        .addScaledVector(f.forward, -f.radius * 0.1);
      // Nghiêng ngược về sau một chút để vây "chỉa" ra sau như vây thật.
      this.tmpDir
        .copy(f.up)
        .addScaledVector(f.forward, -0.42)
        .addScaledVector(f.right, Math.sin(time * 2.1 + i) * 0.05)
        .normalize();
      fin.quaternion.setFromUnitVectors(up, this.tmpDir);
      fin.scale.set(f.radius * 0.13, h, f.radius * 0.62);
    }
  }

  private readonly tmpHip = new Vector3();
  private readonly tmpTarget = new Vector3();
  private readonly tmpKnee = new Vector3();
  private readonly tmpDir = new Vector3();
  private readonly tmpBend = new Vector3();
  private readonly tmpClamp = new Vector3();
  private readonly tmpUp = new Vector3();
  private readonly tmpDown = new Vector3();
  private readonly tmpFoot = new Vector3();
  private readonly tmpFoot2 = new Vector3();
  private readonly tmpReach = new Vector3();

  /** Gốc hông thế giới của bốn chân, cùng thứ tự với `legs`. */
  hipPositions(frames: SpineFrame[], out: Vector3[]): Vector3[] {
    for (let i = 0; i < this.legs.length; i += 1) {
      const leg = this.legs[i];
      out[i].copy(
        this.hipOf(frames[Math.min(leg.hipIndex, frames.length - 1)], leg.side, this.tmpHip),
      );
    }
    return out;
  }

  private hipOf(f: SpineFrame, side: number, out: Vector3): Vector3 {
    return out
      .copy(f.position)
      .addScaledVector(f.right, side * f.radius * 0.78)
      .addScaledVector(f.up, -f.radius * 0.34);
  }

  private updateLegs(frames: SpineFrame[], state: DragonState) {
    const stance = this.stance;
    for (let i = 0; i < this.legs.length; i += 1) {
      const leg = this.legs[i];
      const f = frames[Math.min(leg.hipIndex, frames.length - 1)];
      const hip = this.hipOf(f, leg.side, this.tmpHip);
      const l1 = leg.l1 * stance;
      const l2 = leg.l2 * stance;
      const target = this.tmpTarget;
      const goal = state.legTargets[i];
      if (goal && state.legReach > 0.001) {
        target.copy(goal);
        const tuck = this.tmpReach
          .copy(hip)
          .addScaledVector(f.forward, -0.34)
          .addScaledVector(f.up, -0.5)
          .addScaledVector(f.right, leg.side * 0.3);
        target.lerp(tuck, 1 - state.legReach);
      } else {
        // Khi bay: chân co gọn sau hông, nhịp nhàng theo sóng thân.
        const flap = Math.sin(state.time * 3.4 + i * 1.7) * 0.12;
        target
          .copy(hip)
          .addScaledVector(f.forward, -0.42 + flap)
          .addScaledVector(f.up, -0.62 - flap * 0.5)
          .addScaledVector(f.right, leg.side * 0.26);
      }
      // CHẶN TẦM VỚI: khớp không bao giờ được dài ra. Nếu mục tiêu ngoài
      // tầm, bàn chân dừng ở hết duỗi — chân với tới chứ không biến thành
      // một cây sào xuyên qua khung hình.
      const maxReach = (l1 + l2) * 0.97;
      const minReach = Math.abs(l1 - l2) + 0.06;
      this.tmpClamp.subVectors(target, hip);
      const d = this.tmpClamp.length();
      if (d > maxReach) target.copy(hip).addScaledVector(this.tmpClamp, maxReach / d);
      else if (d < minReach) {
        if (d < 1e-4) this.tmpClamp.copy(f.up).multiplyScalar(-1);
        target.copy(hip).addScaledVector(this.tmpClamp, minReach / this.tmpClamp.length());
      }
      this.solveTwoBone(hip, target, l1, l2, f, leg.side, this.tmpKnee);
      const footPos = this.tmpFoot.copy(target);
      this.orientSegment(leg.upper, hip, this.tmpKnee, (leg.front ? 0.25 : 0.21) * stance);
      this.orientSegment(leg.lower, this.tmpKnee, footPos, (leg.front ? 0.17 : 0.145) * stance);
      leg.knee.position.copy(this.tmpKnee);
      leg.knee.scale.setScalar(0.2 * stance);
      // Bàn chân: mũi chúc xuống theo hướng từ gối → bàn, xòe vuốt ra ngoài.
      leg.foot.position.copy(footPos);
      leg.foot.scale.setScalar(stance);
      this.tmpDir.subVectors(footPos, this.tmpKnee).normalize();
      const down = this.tmpDown.set(0, -1, 0);
      const pitch = Math.max(
        -1.2,
        Math.min(1.2, Math.acos(Math.max(-1, Math.min(1, this.tmpDir.dot(down)))) - Math.PI / 2),
      );
      leg.foot.quaternion.setFromUnitVectors(
        AXIS_Z,
        this.tmpFoot2.copy(this.tmpDir).setY(this.tmpDir.y * 0.35).normalize(),
      );
      leg.foot.rotateX(pitch * 0.35 + 0.25);
      leg.foot.rotateZ(leg.side * 0.18);
    }
  }

  /** IK hai khớp giải tích: tìm gối bằng giao điểm hai vòng tròn. */
  private solveTwoBone(
    hip: Vector3,
    target: Vector3,
    l1: number,
    l2: number,
    frame: SpineFrame,
    side: number,
    out: Vector3,
  ) {
    const dir = this.tmpDir.subVectors(target, hip);
    const dist = Math.max(0.05, Math.min(l1 + l2 - 0.02, dir.length()));
    dir.normalize();
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const w = TMP_W.copy(hip).addScaledVector(dir, a);
    // Hướng gập gối: ra sau + ngoài (khuỷu sau của thú), không bao giờ ngược.
    this.tmpBend
      .copy(frame.forward)
      .multiplyScalar(-0.75)
      .addScaledVector(frame.right, side * 0.5)
      .addScaledVector(dir, -dir.dot(frame.forward) * -0.75);
    this.tmpBend.addScaledVector(dir, -this.tmpBend.dot(dir));
    if (this.tmpBend.lengthSq() < 1e-5) this.tmpBend.copy(frame.up).addScaledVector(dir, -frame.up.dot(dir));
    this.tmpBend.normalize();
    out.copy(w).addScaledVector(this.tmpBend, h);
  }

  private orientSegment(mesh: Mesh, from: Vector3, to: Vector3, radius: number) {
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    const dir = this.tmpDir.subVectors(to, from);
    const len = Math.max(0.001, dir.length());
    mesh.quaternion.setFromUnitVectors(AXIS_Y, dir.normalize());
    mesh.scale.set(radius, len, radius);
  }

  /** Điểm gốc của tia lửa trong miệng (world) để hệ lửa bám theo đầu. */
  mouthPoint(out: Vector3): Vector3 {
    const f = this.headAnchor;
    out.set(0, -0.16, 1.42).applyMatrix4(f.matrixWorld);
    return out;
  }

  /** Hướng đầu đang nhìn (world) – trục phun lửa. */
  mouthDirection(out: Vector3): Vector3 {
    this.headAnchor.getWorldQuaternion(TMP_Q);
    return out.set(0, 0, 1).applyQuaternion(TMP_Q).normalize();
  }

  headPosition(out: Vector3): Vector3 {
    return out.setFromMatrixPosition(this.headAnchor.matrixWorld);
  }

  syncMatrices() {
    this.group.updateMatrixWorld(true);
  }

  dispose() {
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

