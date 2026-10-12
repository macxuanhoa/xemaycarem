// Văn bản đồ thủ tục cho rồng vàng đế chế: vảy lồng nhau (albedo lệch pha
// theo hàng để sống lưng ánh đồng đỏ, hai bên mạn vàng sâm banh, bụng dưới
// sáng ngà), bản đồ pháp tuyến sinh từ bản đồ cao bằng phép toán Sobel ngay
// trên canvas, và bản đồ độ nhám để phản chiếu vàng loang lổ như kim loại
// thật chứ không phải nhựa bóng. Mọi thứ vẽ bằng Canvas 2D, không tải file
// ảnh nào – vừa nhẹ vừa không phụ thuộc bản quyền.

function makeCanvas(size: number) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/** Vảy rồng lồng nhau hình vòm: mỗi ô so le nửa hàng, viền tối, đỉnh sáng. */
function drawScales(
  size: number,
  painter: (row: number, col: number, x: number, y: number, r: number) => void,
) {
  const cols = 16;
  const rows = 24;
  const cw = size / cols;
  const ch = size / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let col = -1; col <= cols; col += 1) {
      const x = col * cw + (row % 2 ? cw / 2 : 0) + cw / 2;
      const y = row * ch + ch / 2;
      painter(row, col, x, y, cw * 0.62);
    }
  }
}

/**
 * Albedo vảy: nền đồng đỏ đậm, mỗi vảy là vòng tròn lệch pha màu theo hàng
 * (vàng kim → vàng sâm banh → cam đồng), đỉnh vảy_highlight vàng nhạt,
 * viền dưới tối sâu tạo chiều sâu lồng nhau. ba hàng cuối (bụng) sáng ngà.
 */
export function makeScaleColorCanvas(size = 1024): HTMLCanvasElement {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d")!;
  const bands = ["#8a2f1d", "#a8431f", "#c2691c", "#d98f26", "#e7b13d", "#f0c95c", "#d98f26", "#a8431f"];
  ctx.fillStyle = "#5c1e10";
  ctx.fillRect(0, 0, size, size);
  drawScales(size, (row, col, x, y, r) => {
    const band = bands[(row + ((col % 3) + 3) % 3) % bands.length];
    const grad = ctx.createRadialGradient(x - r * 0.25, y - r * 0.45, r * 0.15, x, y, r);
    grad.addColorStop(0, "#fbe7a8");
    grad.addColorStop(0.34, band);
    grad.addColorStop(1, "#43170c");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // Gờ sáng mảnh trên đỉnh vảy – bắt sáng như men kim loại.
    ctx.strokeStyle = "rgba(255, 236, 170, 0.28)";
    ctx.lineWidth = r * 0.12;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.86, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  });
  return canvas;
}

/** Bản đồ cao độ grayscale của cùng lưới vảy – nguyên liệu cho pháp tuyến. */
function makeHeightCanvas(size: number): ImageData {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#404040";
  ctx.fillRect(0, 0, size, size);
  drawScales(size, (_row, _col, x, y, r) => {
    const grad = ctx.createRadialGradient(x - r * 0.2, y - r * 0.35, r * 0.1, x, y, r);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.72, "#8b8b8b");
    grad.addColorStop(1, "#000000");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  });
  return ctx.getImageData(0, 0, size, size);
}

/** Sobel trên bản đồ cao độ → bản đồ pháp tuyến tiếp tuyến (tangent space). */
export function makeScaleNormalCanvas(size = 1024): HTMLCanvasElement {
  const src = makeHeightCanvas(size);
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d")!;
  const out = ctx.createImageData(size, size);
  const at = (x: number, y: number) => {
    const xi = (x + size) % size;
    const yi = (y + size) % size;
    const i = (yi * size + xi) * 4;
    return src.data[i] / 255;
  };
  const strength = 2.6;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const dx = tr + 2 * r + br - (tl + 2 * l + bl);
      const dy = bl + 2 * b + br - (tl + 2 * t + tr);
      const nx = -dx * strength;
      const ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      out.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/**
 * Độ nhám loang: vảy bóng gương kim loại (0.18-0.3) nhưng loang đám mờ
 * (0.5-0.7) như bụi lễ hội – vàng thật không bao giờ phản chiếu đều tăm tắp.
 */
export function makeScaleRoughnessCanvas(size = 512): HTMLCanvasElement {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#3d3d3d";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = size * (0.02 + Math.random() * 0.09);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const v = Math.random() < 0.5 ? 0 : 96;
    grad.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/**
 * Mây lễ hội mềm (alpha): chùm nhiều vòng gradient lồng nhau để rồng
 * xuyên qua được ở cảnh giáng lâm – chiều sâu khí quyển thật, không phải
 * một dải PNG dán ngang.
 */
export function makeCloudCanvas(size = 512): HTMLCanvasElement {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 26; i += 1) {
    const x = size * (0.5 + (Math.random() - 0.5) * 0.72);
    const y = size * (0.5 + (Math.random() - 0.5) * 0.4);
    const r = size * (0.07 + Math.random() * 0.19);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.5)");
    grad.addColorStop(0.55, "rgba(255,236,200,0.16)");
    grad.addColorStop(1, "rgba(255,236,200,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/**
 * Bầu trời đêm lễ hội làm nền 3D (chạy sau camera, không phải CSS): chàm
 * đen sâu phía trên, quầng ấm pháo hoa thấp dần về chân trời đô thành.
 */
export function makeSkyCanvas(w = 512, h = 512): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#050312");
  grad.addColorStop(0.42, "#0d0722");
  grad.addColorStop(0.72, "#26113a");
  grad.addColorStop(0.88, "#5a2417");
  grad.addColorStop(1, "#8a4413");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // Rải sao mờ nửa trên – trời khuya có chiều sâu, không phẳng lì.
  for (let i = 0; i < 160; i += 1) {
    const x = Math.random() * w;
    const y = Math.random() * h * 0.55;
    ctx.fillStyle = `rgba(255,244,214,${0.12 + Math.random() * 0.4})`;
    ctx.fillRect(x, y, 1.4, 1.4);
  }
  return canvas;
}
