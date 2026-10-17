/**
 * ẢNH THẺ CHUYỂN KHOẢN — một tấm ảnh "tự giải thích".
 *
 * Nhân viên mở mã QR, bấm lưu rồi gửi ảnh cho người chuyển qua Zalo. Nếu ảnh
 * chỉ có mỗi ô mã, người nhận vẫn phải hỏi lại "chuyển bao nhiêu, ghi nội dung
 * gì". Vì vậy số tiền và nội dung chuyển khoản được vẽ THẲNG VÀO ẢNH, kèm chữ
 * ký "Cà Rem" rải quanh mã như dấu chống giả của ngân hàng.
 *
 * Ảnh ghép cũng chính là ảnh hiển thị trên màn hình: thấy sao lưu vậy — không
 * còn cảnh màn hình một kiểu, tệp tải về một kiểu.
 *
 * Bố cục tách khỏi trình vẽ: `planQrCardLayout()` là hàm thuần, chỉ cần một hàm
 * đo chữ nên kiểm được bằng unit test ngoài trình duyệt; `renderQrCardImage()`
 * là phần canvas thật và chưa được gì nếu ghép hỏng (màn hình tự về ảnh thô).
 */

/** Khổ ảnh 800px: hiển thị ~272px trên màn hình vẫn dư nét khi khách phóng to. */
const CARD_WIDTH = 800;
const PAD = 36;
const INNER_WIDTH = CARD_WIDTH - PAD * 2;
/** Mã QR chiếm 60% bề ngang; hai dải còn lại là chỗ rải chữ ký. */
const QR_SIZE = 480;
const QR_X = (CARD_WIDTH - QR_SIZE) / 2;
/** Vòng an toàn quanh mã: chữ ký rải quanh nhưng không được lấn vào ô này. */
const QR_CLEAR = 14;
/** Dải ngang phía trên mã — nơi chữ ký có thể nằm mà không che mã. */
const TOP_BAND = 76;
const WATERMARK_TEXT = "Cà Rem";
// Chủ quán muốn dấu "Cà Rem" phủ DÀY quanh mã: nâng số đích, tăng số lần thử và
// hạ cỡ tối đa để nhét được nhiều hơn vào hai dải hẹp hai bên mà vẫn không đè
// nhau; mờ hơn một chút để càng nhiều chữ ký càng không tranh với mã.
const WATERMARK_TARGET = 30;
const WATERMARK_ATTEMPTS_PER_SPOT = 55;
const WATERMARK_MIN_SIZE = 16;
const WATERMARK_MAX_SIZE = 30;
const WATERMARK_TILT = 22;
const WATERMARK_MIN_OPACITY = 0.1;
const WATERMARK_MAX_OPACITY = 0.24;

const PAPER = "#ffffff";
const INK = "#101722";
const MUTED = "#6b7280";
const RED = "#e01b2d";
const HAIRLINE = "#e7eaf0";

export type QrCardModel = {
  /** "35.000.000 ₫" — định dạng sẵn từ màn hình, lib này không đụng Intl. */
  amountLabel: string;
  /** Nguyên văn chuỗi đã nhúng vào mã QR; ảnh không được cắt hoặc đổi dấu. */
  transferContent: string;
  bankName: string;
  accountNo: string;
  accountName?: string;
  /** Chuỗi ổn định theo từng mã QR: bộ rải chữ ký lấy nhánh ngẫu nhiên từ đây. */
  seedKey: string;
};

export type QrCardImage = {
  dataUrl: string;
  blob: Blob;
  width: number;
  height: number;
};

/** Hàm đo bề rộng một xâu khi vẽ bằng `font` (canvas dùng phông này thật). */
export type MeasureText = (text: string, font: string) => number;

type Align = "left" | "right" | "center";

export type QrTextOp = {
  kind: "text";
  /** nhãn ổn định cho kiểm thử: brand | tagline | account | label | amount | content | note | watermark */
  role:
    | "brand"
    | "tagline"
    | "account"
    | "label"
    | "amount"
    | "content"
    | "note"
    | "watermark";
  text: string;
  /** Với chữ thường: x là mép trái/phải theo `align`, y là đường chân. */
  x: number;
  y: number;
  font: string;
  color: string;
  align: Align;
  /** Chữ ký rải quanh: xoay quanh tâm (x, y), cỡ và độ mờ riêng từng chỗ. */
  rotate?: number;
  opacity?: number;
  size?: number;
};

export type QrRuleOp = { kind: "rule"; y: number };
export type QrImageOp = { kind: "qr"; x: number; y: number; size: number };
export type QrDrawOp = QrTextOp | QrRuleOp | QrImageOp;

export type QrCardLayout = {
  width: number;
  height: number;
  qr: { x: number; y: number; size: number };
  ops: QrDrawOp[];
};

const scriptFont = (size: number) =>
  `400 ${size}px "Allura", "Segoe Script", cursive`;
const labelFont = (size: number) =>
  `700 ${size}px "Plus Jakarta Sans", "Segoe UI", sans-serif`;
const bodyFont = (size: number) =>
  `500 ${size}px "Plus Jakarta Sans", "Segoe UI", sans-serif`;
const monoFont = (size: number) =>
  `500 ${size}px "JetBrains Mono", ui-monospace, monospace`;

/* ---------------------------------------------------------------- bố cục -- */

/**
 * Tách chữ theo khoảng trắng, vừa bề rộng cho trước. Một từ đơn lẻ dài hơn khổ
 * (mã đối soát dính liền mạch) bị cắt theo ký tự: thà trải thêm hàng chứ không
 * bao giờ cắt bớt chữ — khách phải đọc đúng những gì ngân hàng sẽ tự điền.
 */
export function wrapText(
  measure: MeasureText,
  text: string,
  font: string,
  maxWidth: number,
): string[] {
  const chunks: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || measure(candidate, font) <= maxWidth) {
      line = candidate;
      continue;
    }
    chunks.push(line);
    line = word;
  }
  if (line) chunks.push(line);
  if (!chunks.length) return [""];
  // Một từ đơn lẻ dài hơn khổ: cắt dần theo ký tự cho đúng bề ngang ảnh.
  const lines: string[] = [];
  for (const chunk of chunks) {
    if (measure(chunk, font) <= maxWidth) {
      lines.push(chunk);
      continue;
    }
    let piece = "";
    for (const character of chunk) {
      if (piece && measure(piece + character, font) > maxWidth) {
        lines.push(piece);
        piece = character;
      } else piece += character;
    }
    if (piece) lines.push(piece);
  }
  return lines;
}

/** Băm FNV-1a — đủ tốt để một mã QR luôn ra đúng một bố cục chữ ký. */
function hashSeed(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: sinh số ngẫu nhiên CÓ CHỦ ĐÍCH theo mã QR đang hiển thị. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

const overlaps = (a: Rect, b: Rect) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Phóng to hộp bao của một dòng chữ nghiêng `rotate` độ quanh tâm của nó. */
function rotatedBox(
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotate: number,
): Rect {
  const rad = (rotate * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const boxWidth = width * cos + height * sin;
  const boxHeight = width * sin + height * cos;
  return {
    x0: cx - boxWidth / 2,
    y0: cy - boxHeight / 2,
    x1: cx + boxWidth / 2,
    y1: cy + boxHeight / 2,
  };
}

/**
 * Rải chữ ký "Cà Rem" quanh mã: chỉ ba dải trên — trái, phải, phía trên.
 * Phía dưới để trống tuyệt đối vì đó là chỗ của số tiền và nội dung chuyển
 * khoản; ảnh ghép vừa khung nên không lo chữ tràn hàng như HTML trước đây.
 */
function placeWatermarks(
  measure: MeasureText,
  zones: Rect[],
  seedKey: string,
): QrTextOp[] {
  const random = randomFrom(hashSeed(seedKey));
  const weights = zones.map(
    (zone) => (zone.x1 - zone.x0) * (zone.y1 - zone.y0),
  );
  const total = weights.reduce((sum, area) => sum + area, 0);
  const heightOf = (size: number) => size * 0.95;
  const spots: {
    x: number;
    y: number;
    size: number;
    rotate: number;
    opacity: number;
  }[] = [];
  const boxes: Rect[] = [];
  for (let spot = 0; spot < WATERMARK_TARGET; spot += 1) {
    for (let attempt = 0; attempt < WATERMARK_ATTEMPTS_PER_SPOT; attempt += 1) {
      let pick = random() * total;
      let zone = zones[zones.length - 1];
      for (let i = 0; i < zones.length; i += 1) {
        pick -= weights[i];
        if (pick <= 0) {
          zone = zones[i];
          break;
        }
      }
      if (zone.x1 - zone.x0 < 40 || zone.y1 - zone.y0 < 24) continue;
      const size =
        WATERMARK_MIN_SIZE +
        random() * (WATERMARK_MAX_SIZE - WATERMARK_MIN_SIZE);
      const font = scriptFont(size);
      const rotate = (random() * 2 - 1) * WATERMARK_TILT;
      const textWidth = measure(WATERMARK_TEXT, font);
      const box = rotatedBox(0, 0, textWidth, heightOf(size), rotate);
      const halfWidth = (box.x1 - box.x0) / 2;
      const halfHeight = (box.y1 - box.y0) / 2;
      // Chừa 6px: chữ ký không dính mép thẻ cũng không lấn vòng an toàn quanh mã.
      if (
        halfWidth + 6 > (zone.x1 - zone.x0) / 2 ||
        halfHeight + 6 > (zone.y1 - zone.y0) / 2
      )
        continue;
      const x =
        zone.x0 + halfWidth + random() * (zone.x1 - zone.x0 - halfWidth * 2);
      const y =
        zone.y0 + halfHeight + random() * (zone.y1 - zone.y0 - halfHeight * 2);
      const boxAt = rotatedBox(x, y, textWidth, heightOf(size), rotate);
      if (boxes.some((other) => overlaps(other, boxAt))) continue;
      boxes.push(boxAt);
      spots.push({
        x,
        y,
        size,
        rotate,
        opacity:
          WATERMARK_MIN_OPACITY +
          random() * (WATERMARK_MAX_OPACITY - WATERMARK_MIN_OPACITY),
      });
      break;
    }
  }
  return spots.map((spot) => ({
    kind: "text" as const,
    role: "watermark" as const,
    text: WATERMARK_TEXT,
    x: spot.x,
    y: spot.y,
    font: scriptFont(spot.size),
    color: RED,
    align: "center" as Align,
    rotate: spot.rotate,
    opacity: spot.opacity,
    size: spot.size,
  }));
}

/**
 * Tính toàn bộ tấm ảnh: khổ, vị trí mã QR, chỗ rải chữ ký và từng dòng chữ.
 * Chiều cao co giãn theo số dòng thực vẽ — memo dài 130 ký tự vẫn nguyên văn.
 */
export function planQrCardLayout(
  model: QrCardModel,
  measure: MeasureText,
): QrCardLayout {
  const ops: QrDrawOp[] = [];
  const text = (op: QrTextOp) => ops.push(op);

  // Khối đầu: góc PHẢI là chữ ký thương hiệu viết tay "Cà Rem • UY TÍN TẠO NIỀM
  // TIN" (font điệu, một hàng chung đường chân); góc TRÁI là tài khoản nhận tiền.
  const lockupRight = CARD_WIDTH - PAD;
  const brandBaseline = PAD + 46;
  const taglineText = "• UY TÍN TẠO NIỀM TIN";
  const taglineFont = labelFont(16);
  const taglineWidth = measure(taglineText, taglineFont);
  const brandFont = scriptFont(46);
  text({
    kind: "text",
    role: "tagline",
    text: taglineText,
    x: lockupRight,
    y: brandBaseline,
    font: taglineFont,
    color: MUTED,
    align: "right",
  });
  // "Cà Rem" viết tay đứng ngay trước slogan, cùng đường chân → một cụm signature.
  text({
    kind: "text",
    role: "brand",
    text: WATERMARK_TEXT,
    x: lockupRight - taglineWidth - 10,
    y: brandBaseline,
    font: brandFont,
    color: RED,
    align: "right",
  });

  const account = [
    model.bankName,
    model.accountNo ? `STK ${model.accountNo}` : "",
    model.accountName || "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  const accountFont = bodyFont(22);
  // Tài khoản nằm DƯỚI cụm chữ ký (không đứng cùng hàng) để không bao giờ chạm
  // vào "Cà Rem • UY TÍN TẠO NIỀM TIN" ở góc phải.
  let y = brandBaseline + 40;
  for (const line of wrapText(measure, account, accountFont, INNER_WIDTH)) {
    text({
      kind: "text",
      role: "account",
      text: line,
      x: PAD,
      y,
      font: accountFont,
      color: INK,
      align: "left",
    });
    y += 30;
  }
  const headerBottom = y - 30 + 12;
  ops.push({ kind: "rule", y: headerBottom + 4 });

  // Mã QR + chữ ký rải ở ba dải quanh nó.
  const qrTop = headerBottom + TOP_BAND;
  const qrBottom = qrTop + QR_SIZE;
  ops.push({ kind: "qr", x: QR_X, y: qrTop, size: QR_SIZE });
  const bands: Rect[] = [
    {
      x0: PAD,
      y0: headerBottom + 14,
      x1: CARD_WIDTH - PAD,
      y1: qrTop - QR_CLEAR,
    },
    { x0: PAD, y0: qrTop, x1: QR_X - QR_CLEAR, y1: qrBottom },
    {
      x0: QR_X + QR_SIZE + QR_CLEAR,
      y0: qrTop,
      x1: CARD_WIDTH - PAD,
      y1: qrBottom,
    },
  ];
  for (const watermark of placeWatermarks(measure, bands, model.seedKey)) {
    ops.push(watermark);
  }

  // Khối dưới: một DÒNG NHỎ số tiền + nội dung — chủ quán muốn gọn, không còn
  // khối chữ thật to chiếm ảnh. Vai trò (amount/content) giữ nguyên để đối soát.
  const infoTop = qrBottom + 26;
  ops.push({ kind: "rule", y: infoTop });
  const amountBaseline = infoTop + 40;
  text({
    kind: "text",
    role: "label",
    text: "SỐ TIỀN",
    x: PAD,
    y: amountBaseline,
    font: labelFont(15),
    color: MUTED,
    align: "left",
  });
  text({
    kind: "text",
    role: "amount",
    text: model.amountLabel,
    x: CARD_WIDTH - PAD,
    y: amountBaseline,
    font: labelFont(30),
    color: RED,
    align: "right",
  });

  let cursor = amountBaseline + 34;
  text({
    kind: "text",
    role: "label",
    text: "NỘI DUNG CHUYỂN KHOẢN",
    x: PAD,
    y: cursor,
    font: labelFont(15),
    color: MUTED,
    align: "left",
  });
  // Memo tối đa 130 ký tự: ưu tiên chữ vừa phải, hạ cỡ khi cần chen vào ≤ 3 hàng.
  // Không bao giờ cắt chữ — thà ảnh cao thêm còn hơn mất một ký tự đối soát.
  const contentSizes = [22, 20, 18, 16];
  let contentSize = contentSizes[contentSizes.length - 1];
  let contentLines = wrapText(
    measure,
    model.transferContent,
    monoFont(contentSize),
    INNER_WIDTH,
  );
  for (const size of contentSizes) {
    const candidate = wrapText(
      measure,
      model.transferContent,
      monoFont(size),
      INNER_WIDTH,
    );
    contentSize = size;
    contentLines = candidate;
    if (candidate.length <= 3) break;
  }
  cursor += 30;
  for (const line of contentLines) {
    text({
      kind: "text",
      role: "content",
      text: line,
      x: PAD,
      y: cursor,
      font: monoFont(contentSize),
      color: INK,
      align: "left",
    });
    cursor += Math.round(contentSize * 1.32);
  }

  cursor += 18;
  ops.push({ kind: "rule", y: cursor });
  cursor += 30;
  const noteFont = bodyFont(18);
  const noteLines = wrapText(
    measure,
    "Chuyển ĐÚNG nội dung này để Cà Rem tự xác nhận đã nhận tiền.",
    noteFont,
    INNER_WIDTH,
  );
  for (const line of noteLines) {
    text({
      kind: "text",
      role: "note",
      text: line,
      x: PAD,
      y: cursor,
      font: noteFont,
      color: MUTED,
      align: "left",
    });
    cursor += 26;
  }

  return {
    width: CARD_WIDTH,
    // Chừa thêm 10px đáy: hàng chữ cuối không dính vào viền thẻ khi gửi ảnh.
    height: Math.round(cursor - 28 + PAD + 10),
    qr: { x: QR_X, y: qrTop, size: QR_SIZE },
    ops,
  };
}

/* ------------------------------------------------------------- trình vẽ -- */

const CARD_FONT_SAMPLE = "Cà Rem 0123456789 nội dung chuyển khoản ₫";

/** Phông web cần về kịp để chữ ký Allura và hàng số mono vẽ đúng như màn hình. */
async function loadCardFonts(): Promise<void> {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`400 58px "Allura"`, CARD_FONT_SAMPLE),
      document.fonts.load(`700 42px "Plus Jakarta Sans"`, CARD_FONT_SAMPLE),
      document.fonts.load(`500 28px "JetBrains Mono"`, CARD_FONT_SAMPLE),
    ]);
  } catch {
    /* Phông chưa về kịp: ảnh vẫn ghép được bằng phông hệ thống. */
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Ảnh gốc đã được tải về thành data URL trước khi ghép; nếu phải nạp thẳng
    // từ server thì xin CORS để khung ảnh không bị "nhiễm" (toDataURL sẽ hỏng).
    if (!source.startsWith("data:")) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("QR_IMAGE_UNREADABLE"));
    image.src = source;
  });
}

/**
 * Data URL PNG sang blob để làm tệp chia sẻ. Đi đường này thay vì giữ lại
 * blob của ảnh gốc: tấm ảnh gửi cho khách phải là ảnh đã ghép.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

/**
 * Ghép tấm ảnh thẻ hoàn chỉnh từ một ảnh mã QR (data URL là chắc nhất) và
 * thông tin giao dịch. Trả về cả data URL để hiển thị lẫn blob PNG để lưu.
 */
export async function renderQrCardImage(
  qrImageSource: string,
  model: QrCardModel,
): Promise<QrCardImage> {
  await loadCardFonts();
  const scratch = document.createElement("canvas");
  const measurer = scratch.getContext("2d");
  if (!measurer) throw new Error("CANVAS_UNAVAILABLE");
  const measure: MeasureText = (text, font) => {
    measurer.font = font;
    return measurer.measureText(text).width;
  };
  const layout = planQrCardLayout(model, measure);
  const qrImage = await loadImage(qrImageSource);

  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("CANVAS_UNAVAILABLE");

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Viền đỏ nhạt: tấm ảnh gửi đi vẫn ra "thẻ của Cà Rem", không phải tờ giấy trắng.
  ctx.strokeStyle = "rgba(224, 27, 45, 0.22)";
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);

  for (const op of layout.ops) {
    if (op.kind === "rule") {
      ctx.strokeStyle = HAIRLINE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(PAD, op.y);
      ctx.lineTo(CARD_WIDTH - PAD, op.y);
      ctx.stroke();
      continue;
    }
    if (op.kind === "qr") {
      ctx.drawImage(qrImage, op.x, op.y, op.size, op.size);
      continue;
    }
    ctx.font = op.font;
    ctx.fillStyle = op.color;
    ctx.textAlign = op.align;
    ctx.globalAlpha = op.opacity ?? 1;
    if (op.rotate !== undefined) {
      ctx.save();
      ctx.textBaseline = "middle";
      ctx.translate(op.x, op.y);
      ctx.rotate((op.rotate * Math.PI) / 180);
      ctx.fillText(op.text, 0, 0);
      ctx.restore();
    } else {
      ctx.textBaseline = "alphabetic";
      ctx.fillText(op.text, op.x, op.y);
    }
    ctx.globalAlpha = 1;
  }

  const dataUrl = canvas.toDataURL("image/png");
  return {
    dataUrl,
    blob: dataUrlToBlob(dataUrl),
    width: layout.width,
    height: layout.height,
  };
}
