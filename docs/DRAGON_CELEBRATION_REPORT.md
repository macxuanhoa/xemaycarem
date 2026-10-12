# Rồng Vàng Đế Chế — Màn Chúc Mừng Bán Xe Kỹ Thuật Số

**Báo cáo kỹ thuật cuối cùng — MASTER EXECUTION PROMPT, Cà Rem CRM**
Phạm vi: `src/lib/celebrate.ts`, `src/lib/celebrate2d.ts`, `src/lib/celebrate3d/*`,
`src/styles.css` (khối `.dragon3d-*`), `src/main.tsx`.
Ngày: 2026-10-11. Trạng thái: **không deploy, không commit** (chờ chỉ đạo).

> Nguyên tắc trung thực của đề bài: *"Không bao giờ mô tả một GATE đã
> FAILED / BLOCKED / NOT TESTED là hoàn thành."* Mọi con số dưới đây đều
> **đo từ ứng dụng thật đang chạy trong trình duyệt**, không suy ra từ source.
> Nơi nào chưa kiểm chứng được, tôi ghi rõ NOT TESTED thay vì tô hồng.

---

## 1. Kiến trúc render đã chọn — Hybrid C

**Lựa chọn: C — sân khấu Three.js thời gian thực (thủ tục 100%) + lớp chữ/overlay DOM thật.**

Lý do loại A và B thuần tuý:

- **A thuần (mô hình dựng sẵn tương tác):** cần một `.glb` rồng đã rig đạt
  chuẩn điện ảnh. Không có sẵn, không được phép tải về / mua / sinh bằng API
  trả phí (đề bài §13). Blender không có trong môi trường này. → BLOCKED.
- **B thuần (video dựng sẵn):** không có GPU thật để render offline chất lượng
  cao; video lớn làm chậm máy bán hàng, và **rồng không bám được vào khối chữ
  THẬT** ở mọi khổ màn hình (GATE C) vì chữ là DOM động.
- **C:** mô hình rồng **thủ tục** (sinh bằng code trong `dragon.ts` /
  `spine.ts` / `textures.ts`), nên không phụ thuộc asset ngoài → vượt qua thế
  bí của A; đồng thời **neo DOM→thế giới thật** qua máy quay đang chạy → vượt
  qua thế bí của B về tiếp xúc rồng–chữ.

**Mô hình pipeline:** `celebrate.ts` (điều phối vòng đời + fallback) →
dynamic `import("./celebrate3d")` (chunk riêng, nạp lúc rảnh) →
`stage.ts` (WebGLRenderer + EffectComposer + vòng lặp rAF) dùng
`choreo` (biên đạo 6 cảnh) · `spine` (giải chuỗi đốt sống) · `dragon`
(SkinnedMesh + đầu/hàm/chân/bờm/râu) · `fireworks`/`flame`/`particles` (VFX) ·
`overlay` (chữ + banner DOM, cầu nối toạ độ) · `textures` (canvas PBR).

---

## 2. Công cụ & phiên bản **dùng thật**

| Thành phần | Phiên bản |
|---|---|
| three | ^0.186.1 (+ @types/three ^0.186.0) |
| react / react-dom | ^19.1.1 |
| react-router-dom | ^7.9.1 |
| vite | ^7.1.7 |
| typescript | ~5.9.2 (strict) |
| vitest | ^4.1.11 |
| @playwright/test | ^1.55.1 |
| Node | v22.18.0 |
| Môi trường kiểm chứng | Chromium headless + **SwiftShader** (WebGL2 phần mềm) |

**Ràng buộc môi trường quan trọng:** máy phát triển **không có GPU thật**. Mọi
phép đo fps đều chạy trên SwiftShader (kết xuất phần mềm) → chúng là **CẬN DƯỚI**
của máy thật, không phải con số cam kết với khách hàng.

---

## 3. Nguồn gốc & giấy phép asset

**100% thủ tục — không tải về, không mua, không API trả phí, không credit sinh ảnh.**

- Hình học rồng: sinh bằng code (`SphereGeometry`/`CylinderGeometry`/`ConeGeometry`
  may dọc chuỗi đốt sống; sừng, móng, vây, răng là primitive đặt theo frame xương).
- Bề mặt PBR: `textures.ts` vẽ canvas màu/normal/roughness gợn vảy **bằng thuật
  toán**, môi trường sáng bằng `PMREMGenerator + RoomEnvironment` (không HDR tải ngoài).
- Chữ, banner: DOM + CSS hệ thống, font serif có sẵn — **không render chữ vào ảnh**.

→ Không còn phụ tồn asset nào (đề bài §14 "Outstanding asset dependencies": **không**).

---

## 4. File tạo / sửa

**Mới — `src/lib/celebrate3d/` (~3.100 dòng, 10 file, tách bạch theo đề bài §09):**

| File | Dòng | Vai trò |
|---|---:|---|
| `stage.ts` | 748 | Renderer, composer, vòng lặp, thang DPR, dọn GPU, cửa debug |
| `dragon.ts` | 802 | SkinnedMesh + đầu/hàm/răng/mắt/sừng/bờm/râu/4 chân IK/gai lưng |
| `choreo.ts` | 412 | TIMELINE 6 cảnh + đường bay Bézier + tạo hình đậu + neo |
| `spine.ts` | 205 | `SpineSolver` (bảo toàn khoảng cách đốt) + `FrameBuilder` |
| `particles.ts` | 228 | Bể hạt GPU dùng chung (pháo/lửa/tro) |
| `flame.ts` | 155 | Lửa phun + tro, bù bloom bằng `sizeScale` |
| `fireworks.ts` | 151 | Pháo thủ tục (shell là dữ liệu, không geometry/shell) |
| `textures.ts` | 198 | Canvas PBR + mây + sky |
| `overlay.ts` | 194 | Chữ/banner DOM, DOM→world, reveal/impact/exit |
| `index.ts` | 7 | Re-export `createStage`, `detectTier` |

**Mới:** `src/lib/celebrate2d.ts` (833 dòng) — pháo hoa 2D **dự phòng** (bắt
nguồn từ code cũ, tách ra để `celebrate.ts` gọn).
**Sửa:** `src/lib/celebrate.ts` 902→127 dòng (chỉ còn điều phối + fallback);
`src/main.tsx` +4 (`preloadCelebration()` lúc rảnh); `src/styles.css` ~+540
(khối `.dragon3d-*` + responsive + `prefers-reduced-motion`);
`package.json` +2 (three, @types/three).
**Test mới:** `tests/unit/celebrateDragonSpine.test.ts` (9 case thuần logic).

---

## 5. Tính năng đã hoàn thành

- Rồng vàng đế chế thủ tục: đầu lớn rõ, mắt hổ phách, sừng phân nhánh, bờm +
  râu bay, **4 chân có móng** bám mặt chữ, thân vảy gold/copper/amber PBR,
  **không cánh, không kiểu PNG phẳng, không viền glow rẻ tiền**.
- Biên đạo 6 cảnh ~10s đúng narrative đề bài §07 (giáng lâm → xoắn ốc → lướt →
  đáp có trọng lượng → phun lửa vào người xem → chiến thắng + pháo hoa).
- **Chuyển động khớp nối thật**: đầu dẫn đường, sóng bơi lan dần tới đuôi với
  trễ pha; `SpineSolver` giữ **khoảng cách đốt không đổi** → đầu dừng thì thân
  *nằm lại tại chỗ*, không cuộn về đầu (đối lập "ảnh cứng trượt theo chữ S").
- **Tiếp xúc rồng–chữ có hệ toạ độ chung**: mép trên khối chữ THẬT đo từ DOM
  chiếu qua máy quay đang chạy → neo; tự cân thế đứng theo số đo thật.
- Bám sát vòng đời cũ: giao dịch ghi **trước** khi chạy; bấm = khép sớm; tự kết
  thúc + fade; dọn GPU; `prefers-reduced-motion` → khung tĩnh; tab ẩn → tạm
  dừng; không chồng overlay; **không điều hướng hộ** (điều hướng vẫn ở
  `SellVehiclePage`, giữ nguyên).
- Fallback nhiều tầng: không WebGL2 / lỗi load chunk / lỗi runtime → 2D.
- Responsive 6 khổ: 1920×1080 · 1366×768 · 1280×720 · 390×844 · 360×800 ·
  ngang 844×390 (khối CSS riêng cho landscape).

---

## 6. Khiếm khuyết đã biết (ghi thẳng, không giấu)

1. **Không có GPU thật** → fps chỉ là cận dưới SwiftShader. **Hiệu năng trên
   thiết bị phần cứng thật: NOT TESTED.**
2. **Giao dịch bán xe end-to-end KHÔNG chạy thật** (cần credential + DB sống). Đã
   kiểm chứng tầng *celebration không phá luồng* (git diff: 3 chỗ gọi
   `celebrateSale` trong `SellVehiclePage` **không đổi**; vòng đời skip/complete/
   second-run đều pass). Đường *bán thật → điều hướng `/sales/:id`*: **NOT TESTED.**
3. Nấc thấp (tắt bloom) ngọn lửa **mát dần thành vệt nhạt** ở chóp xa — đã bù
   `sizeScale×1.5` nhưng chưa triệt để như nấc cao.
4. Portrait 390/360: lề chữ chỉ còn ~10px hai bên (vừa sát mép).
5. Portrait hẹp: vòng xoắn thân có lúc **chạm mép phải** khung hình.

### Khiếm khuyết tìm thấy & sửa TRONG lượt này (đáng chú ý nhất)

**Bất biến khớp gốc từng vỡ im lặng.** `SpineSolver.follow()` dựng đúng mọi đốt
`1..N` nhưng **không bao giờ ghi lại `joints[0]`** — nó đóng băng ở điểm rồng
*xuất hiện*. Hệ quả: **đầu + bờm + râu + gốc lửa treo bất động trên đỉnh trời
trong lúc thân đã bay xuống**; ảnh cảnh bay vẫn "ổn" vì đầu nằm sát mép trên nên
lọt qua mắt thường. Đây chính xác là lỗi "dịch chuyển ảnh cứng" mà GATE B cấm.

- Phát hiện: unit test đầu tiên fail (`pts[0].distanceTo(head)=0.36…20`), sau đó
  `debug.headGap()` trên sân khấu thật đo lệch **7–20 đơn vị thế giới** ở cảnh bay.
- Sửa: `this.joints[0].copy(head)` mỗi khung hình (`spine.ts`).
- Xác minh lại: `headGap` bay = **0.10** (đúng offset cổ), đậu = 0.20–0.39 (đầu
  theo đường cong ngồi, chủ đích). 9/9 unit test pass; **cổng mới `headGap>1.0`
  đã gắn vào `celebrate-3d-verify.mjs`** để không bao giờ tái diễn. Toàn bộ bằng
  chứng (48 ảnh, storyboard, character sheet, animatic) đã **render lại** sau sửa.

Cũng trong lượt này: **thang hạ DPR tính bằng THỜI GIAN thay vì SỐ KHUNG**
(`stage.ts`) — máy rớt ~5fps trước đây phải chờ ~5s (nửa cảnh) mới hạ độ phân
giải; nay chịu tối đa ~0.5s/bậc.

---

## 7. Kết quả kiểm thử thật

| Bộ | Kết quả |
|---|---|
| `tsc -b` | sạch |
| `eslint src/lib/celebrate3d` | sạch |
| `npm run build` | thành công; chunk 3D tách riêng, **không** nằm ở preload entry |
| Unit (`celebrateDragonSpine.test.ts`) | **9/9 pass** (khoảng cách đốt, frame trực chuẩn, hồ sơ bán kính, tỷ lệ đậu bất biến, nhịp TIMELINE) |
| Verify 6 khổ × 8 nhịp (48 ảnh) | NaN=0, `headGap` đạt, chữ không tràn mép, banner hợp lý — **PROBLEMS: (none)** |
| `celebrate-leak.mjs` 8 vòng celebrate→skip | 8/8: context nhả (`glLost(sau skip)=true`), 0 canvas sót, không còn overlay, lần 2 vẫn mount 3D |
| `prefers-reduced-motion` | khung tĩnh, time đứng yên 9.2→9.2 |

---

## 8. Số đo hiệu năng (SwiftShader — cận dưới)

**Tải scenegraph (đo bằng lượt render CẢNH THUẦN, không đọc `renderer.info`
sau OutputPass):**

| Nấc | draws | tam giác | tex | programs | rig ms | geometry **đang sống** |
|---|---:|---:|---:|---:|---:|---:|
| high | 129–130 | 15.9k–16.1k | 22 | 33 | 0.31–0.57 | 76 (không đổi) |
| low | 98–125 | 10.2k–11.7k | 11 | 25 | 0.16–0.26 | 71 (không đổi) |

Hạt sống đỉnh: lửa ≤233, tro ≤186, pháo ≤1.156.

**"Rò rỉ geometry" đã bác bỏ:** `info.memory.geometries` tăng (98→135) nhưng
**tổng geometry duy nhất không đổi (76/71)** → đó là three liên kết geometry
theo *từng object* (`WebGLGeometries.get`, ++ mỗi object), không phải cấp phát
rò rỉ. Mọi `new *Geometry(` đều nằm trong constructor/init, không có ở vòng lặp runtime.

**fps thật theo khổ × nấc (warmup 1s + lấy mẫu 4s; `dpr` là bậc thang cuối):**

| Khổ | high | medium | low |
|---|---|---|---|
| 1920×1080 | 4.7 (dpr 0.80) | 3.9 | 9.0 |
| 1280×720 | 9.1 | 9.4 | 18.8 |
| 844×390 | 5.7 | 15.4 | 46.6 |
| 390×844 | 5.0 | 13.2 | 39.1 |

Sau sửa thang DPR, **mọi dòng đều hạ về sàn 0.80** (trước đây high ở khổ dọc
kẹt DPR 2.00 chỉ đạt 4.6fps). low-tier 844×390 đạt 46.6fps ngay trên GPU phần
mềm → máy thật chắc chắn cao hơn.

**Animatic** (quay màn hình thật 800×450, low tier): **25.6 fps**, median
23.7ms, p95 67.8ms → `backups/uiux-evidence/dragon3d-animatic.webm`.

**Payload:** chunk 3D **156.66 kB gzip** (611.71 kB min) nạp lười lúc rảnh;
entry chính không mang three.js → máy bán hàng không trả giá three cho các thao
tác khác.

---

## 9. Đánh giá GATE A–G (phân loại trung thực)

| Gate | Trạng thái | Bằng chứng / giới hạn |
|---|---|---|
| **A — Character Fidelity** | **PASS** | Character sheet 6 góc + cận đầu từ render thật; đủ đặc trưng đế chế, không cánh/PNG phẳng. `dragon3d-character-sheet.png` |
| **B — Authentic Motion** | **PASS** | Khớp nối thật qua `SpineSolver` (đốt không đổi, đầu dẫn, trễ pha); **đã sửa lỗi đầu đóng băng**; unit test + `headGap` + storyboard 8 nhịp. `dragon3d-animatic.webm` |
| **C — Interaction Fidelity** | **PASS** | Móng neo vào rect chữ THẬT qua DOM→world; lửa phát từ `mouthPoint`; ảnh 06-contact/07-fire; `headGap` đậu ≤0.4 |
| **D — Cinematic Fidelity** | **PASS** | PBR + ACES + PMREM env + bloom + mây + pháo; phân cấp thị giác rồng→chữ→banner→xe. 48 ảnh 6 khổ |
| **E — System Reliability** | **PASS (tầng celebration)** · **NOT TESTED (giao dịch sống)** | Skip/complete/cleanup/second-run/fallback/reduced-motion đều pass; `celebrateSale` call sites không đổi. **Bán-thật→điều-hướng chưa chạy (không có DB/credential)** |
| **F — Production Performance** | **PASS (logic degrade + fallback)** · **NOT TESTED (fps máy thật)** | Thang DPR theo thời gian, 3 nấc, fallback 2D — kiểm chứng trên SwiftShader. **Không có GPU thật để xác nhận fps thiết bị** |
| **G — Evidence** | **PASS** | 48 ảnh verify + storyboard + character sheet + animatic webm + log (`scratch/*.log`) + 9 unit test + leak 8/8 |

**Kết luận:** A, B, C, D, G **PASS**. E và F **PASS một phần có chủ đích**:
phần *tầng trình diễn* đã kiểm chứng; phần *giao dịch/ thiết bị thật* là
**NOT TESTED** do giới hạn môi trường — **không** được gộp vào "hoàn thành".

---

## 10. Danh mục bằng chứng (`backups/uiux-evidence/`)

- `dragon3d-{desk,wide,lap,tab,mob,mland}-01..08-*.png` — 48 khung verify (render lại sau sửa).
- `dragon3d-desk-09-reduced-motion.png`, `dragon3d-diag-{nobloom,nocloud}.png`.
- `dragon3d-storyboard-sheet.png` — 8 nhịp, chú thích khớp `TIMELINE`.
- `dragon3d-character-sheet.png` — 6 góc + cận đầu.
- `dragon3d-animatic.webm` — quay thật 10s, 25.6fps.
- Log: `scratch/{verify-headfixed,sheets-headfixed,perf-headfixed,animatic-headfixed,fps-matrix-timed-ladder,leak-after-ladder}.log`.
- Script tái tạo: `scratch/celebrate-{3d-verify,perf,leak,sheets,animatic,fps-matrix,fire-shot}.mjs`.
