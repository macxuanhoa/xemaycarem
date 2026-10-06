/**
 * Camera thông minh — nhận diện xe bằng ảnh và nối thẳng vào hai luồng nghiệp
 * vụ có sẵn: mở hồ sơ xe đã có trong CRM hoặc transfer kết quả nhận diện sang
 * biểu mẫu Thu xe tốc ký. Không có đường ghi nào ở đây: mọi bản ghi vẫn do
 * biểu mẫu tốc ký xác nhận từng bước như trước.
 *
 * Kiến trúc nhận diện ba tầng, ưu tiên chi phí tăng dần:
 *   1. QR/mã vạch — ZXing giải mã ngay trên máy, miễn phí.
 *   2. OCR trên máy — Tesseract WASM trong worker riêng (biển số, số khung,
 *      số máy), không rời khỏi thiết bị, không tốn tiền, chạy liên tục với
 *      lấy mẫu thích ứng + bình bỏ qua nhiều khung hình ổn định.
 *   3. AI trên mây (ai-assist `vehicle_scan`) — chỉ khi máy không đọc ra hoặc
 *      người dùng bấm nút, có hạn mức/giờ và sổ theo dõi từng lượt gọi.
 * "Tít" chỉ reo khi khớp duy nhất đã xác minh với kho; beep chống lặp theo
 * đối tượng quét.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BadgeCheck,
  Camera,
  CircleAlert,
  Cpu,
  Images,
  ScanLine,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { canOperate } from "@/lib/permissions";
import { resolveVehicleQr } from "@/lib/qrcode";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button, Card, Field } from "@/components/ui";
import {
  classifyFields,
  normalizeScan,
  saveRecognitionDraft,
  scanTargetKey,
  type Recognition,
  type RecognitionFieldStatus,
  type ScannedKey,
} from "@/lib/smartcam/recognition";
import {
  captureFromFile,
  captureVideoFrame,
  dataUrlToCanvas,
  frameSharpness,
  loadCameraSettings,
  saveCameraSettings,
  scanTone,
  type CameraSettings,
  type CapturedFrame,
} from "@/lib/smartcam/capture";
import { lookupScan } from "@/lib/smartcam/lookup";
import { localReadFrame, onOcrStageChange, ocrStage, releaseOcrWorker, type OcrStage } from "@/lib/smartcam/local/ocr";
import { detectCodes } from "@/lib/smartcam/local/barcodes";
import { motionScore, sceneSignature, sourceCanvas, toGray } from "@/lib/smartcam/local/frames";
import { nextTickMs, pushVote, type VoteState } from "@/lib/smartcam/local/voting";
import { cloudAllowed, loadLedger, recordCall, saveLedger, summarize, type CloudCall } from "@/lib/smartcam/local/budget";

const FIELD_LABELS: Record<ScannedKey, string> = {
  license_plate: "Biển số",
  frame_number: "Số khung",
  engine_number: "Số máy",
  brand: "Hãng",
  model: "Dòng xe",
  variant: "Phiên bản",
  color: "Màu",
  year: "Năm",
  odometer: "Số km",
};

const STATUS_LABELS: Record<RecognitionFieldStatus, string> = {
  VERIFIED: "đã xác khớp",
  SUGGESTED: "cần kiểm tra",
  UNREADABLE: "chưa đọc được",
  CONFLICT: "mâu thuẫn",
};

const STATUS_ORDER: RecognitionFieldStatus[] = ["CONFLICT", "SUGGESTED", "VERIFIED", "UNREADABLE"];

const VEHICLE_STATUS_LABELS: Record<string, string> = {
  IN_STOCK: "còn kho",
  RESERVED: "đã giữ chỗ",
  SOLD: "đã bán",
};

const OCR_STAGE_LABELS: Record<OcrStage, string> = {
  idle: "OCR trên máy: chờ mở camera",
  loading: "Đang tải mô-đun OCR trên máy (một lần duy nhất)…",
  ready: "OCR trên máy: sẵn sàng — ảnh không rời khỏi điện thoại",
  unavailable: "OCR trên máy không tải được — dùng ảnh thư viện, AI hoặc nhập tay",
};

/** Auto-capture only fires on a frame at least this sharp (0..1). */
const CLARITY_THRESHOLD = 0.35;
/** Sharp local misses before one automatic (budgeted) cloud read. */
const AUTO_FALLBACK_MISSES = 6;
/** ZXing is CPU-sync — decode codes every other processed tick. */
const CODE_TICK_EVERY = 2;
/** Scene signature delta that invalidates the current candidate vote. */
const SCENE_CHANGE_RESET = 0.35;

function ResultChips({ recognition }: { recognition: Recognition }) {
  const entries = (Object.keys(FIELD_LABELS) as ScannedKey[])
    .filter((key) => recognition.fields[key])
    .sort((a, b) => STATUS_ORDER.indexOf(recognition.statuses[a]) - STATUS_ORDER.indexOf(recognition.statuses[b]));
  if (!entries.length) return null;
  return (
    <div className="smartcam-chips" aria-label="Các trường nhận diện được">
      {entries.map((key) => (
        <span key={key} className={`smartcam-chip status-${recognition.statuses[key].toLowerCase()}`}>
          <strong>{FIELD_LABELS[key]}:</strong> {recognition.fields[key]}
          <small>{STATUS_LABELS[recognition.statuses[key]]}</small>
        </span>
      ))}
    </div>
  );
}

type ScanMetrics = { ocrMs: number; lookupMs: number; cloudMs: number; via: "local" | "cloud" | "code" };

export default function SmartVehicleScan() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const resultRef = useRef<Recognition | null>(null);
  const lastTargetKey = useRef("");
  const voteRef = useRef<VoteState>(null);
  const missRef = useRef(0);
  const sharpRef = useRef(false);
  const prevSigRef = useRef<Float32Array | null>(null);
  const tickCountRef = useRef(0);
  const ledgerRef = useRef<CloudCall[]>(loadLedger());
  const mounted = useRef(true);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Recognition | null>(null);
  const [settings, setSettings] = useState<CameraSettings>(loadCameraSettings);
  const [consent, setConsent] = useState(false);
  const [engine, setEngine] = useState<OcrStage>(ocrStage());
  const [liveHint, setLiveHint] = useState("");
  const [metrics, setMetrics] = useState<ScanMetrics | null>(null);
  const [cloudUsage, setCloudUsage] = useState(() => summarize(ledgerRef.current, Date.now()));
  const operate = canOperate(profile);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onOcrStageChange(setEngine);
    return () => {
      mounted.current = false;
      unsubscribe();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      // Free the ~50 MB WASM heap when the camera screen goes away for good.
      releaseOcrWorker();
    };
  }, []);

  const commitResult = useCallback((recognition: Recognition | null) => {
    resultRef.current = recognition;
    setResult(recognition);
  }, []);

  const updateSettings = (patch: Partial<CameraSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveCameraSettings(next);
      return next;
    });
  };

  const trackLedger = (call: Omit<CloudCall, "ts">) => {
    ledgerRef.current = recordCall(ledgerRef.current, { ...call, ts: Date.now() });
    saveLedger(ledgerRef.current);
    setCloudUsage(summarize(ledgerRef.current, Date.now()));
  };

  const stopCamera = useCallback(async () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (mounted.current) setRunning(false);
  }, []);

  const startCamera = useCallback(async () => {
    if (streamRef.current || busyRef.current) return;
    setMessage("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setRunning(true);
      // Warm the local OCR worker while the camera spins up (free, cached).
      void (settings.localOcr ? import("@/lib/smartcam/local/ocr").then((m) => void m.ensureOcrWorker()) : null);
    } catch {
      if (mounted.current)
        setMessage(
          "Không mở được camera. Kiểm tra quyền camera, chọn ảnh từ thư viện hoặc nhập biển số/số khung thủ công bên dưới.",
        );
    }
  }, [settings.localOcr]);

  /** Shared tail: normalized fields → CRM lookup → provenance + sound + card. */
  const finishWithFields = useCallback(
    async (
      draft: Record<string, unknown>,
      via: "local" | "cloud",
      frame: CapturedFrame | null,
      timing: { ocrMs: number; cloudMs: number },
    ): Promise<boolean> => {
      const fields = normalizeScan(draft);
      if (!Object.values(fields).some(Boolean)) return false;
      const lookupStarted = performance.now();
      const match = await lookupScan(fields);
      const lookupMs = Math.round(performance.now() - lookupStarted);
      const recognition: Recognition = {
        version: 1,
        scannedAt: new Date().toISOString(),
        fields,
        statuses: classifyFields(fields, match),
        match,
        photos: frame ? [frame.dataUrl] : [],
        source: via,
      };
      const targetKey = scanTargetKey(match, fields);
      if (targetKey !== lastTargetKey.current) {
        lastTargetKey.current = targetKey;
        // Success "tít" only for a verified unique match; review states get a
        // neutral tone; "new vehicle" stays silent (it is not a confirmation).
        if (settings.sound && match.state === "unique") scanTone("match");
        else if (settings.sound && match.state !== "none") scanTone("review");
      }
      setMetrics({ ocrMs: timing.ocrMs, lookupMs, cloudMs: timing.cloudMs, via });
      commitResult(recognition);
      saveRecognitionDraft(profile?.id, recognition);
      voteRef.current = null;
      missRef.current = 0;
      setLiveHint("");
      void stopCamera();
      if (match.state === "unique" && settings.autoOpen) navigate(`/vehicles/${match.vehicle.id}`);
      return true;
    },
    [commitResult, navigate, profile?.id, settings.autoOpen, settings.sound, stopCamera],
  );

  /** Paid cloud read — consent, budget and the per-call ledger all apply. */
  const cloudRead = useCallback(
    async (frame: CapturedFrame, budgetKey: string, automatic: boolean): Promise<boolean> => {
      if (!consent) {
        setMessage(
          automatic
            ? "Máy chưa đọc được — bật đồng ý gửi ảnh nếu muốn Cà Rem thử bằng AI."
            : "Bật đồng ý gửi ảnh ở trên trước khi Cà Rem được phép đọc ảnh xe.",
        );
        return false;
      }
      if (busyRef.current) return false;
      const verdict = cloudAllowed(ledgerRef.current, Date.now(), budgetKey);
      if (!verdict.ok) {
        setMessage(
          verdict.reason === "HOURLY_LIMIT"
            ? `Đã dùng hết ${cloudUsage.perHour} lượt AI trong một giờ. OCR trên máy và nhập tay vẫn dùng bình thường.`
            : "Xe này vừa được AI đọc rồi — kiểm tra lại khung hình hoặc nhập thủ công.",
        );
        return false;
      }
      busyRef.current = true;
      setBusy(true);
      const started = performance.now();
      const imageBytes = Math.round((frame.jpegBase64.length * 3) / 4);
      try {
        const response = await api.assist<{ kind: string; draft?: Record<string, unknown> }>({
          task: "vehicle_scan",
          consent: true,
          image: { mime_type: "image/jpeg", base64: frame.jpegBase64 },
        });
        const latencyMs = Math.round(performance.now() - started);
        trackLedger({ targetKey: budgetKey, latencyMs, imageBytes, outcome: "ok" });
        const draft = response?.kind === "draft" ? (response.draft ?? {}) : {};
        const done = await finishWithFields(draft, "cloud", frame, { ocrMs: 0, cloudMs: latencyMs });
        if (!done && mounted.current)
          setMessage("AI cũng không đọc được thông tin chắc chắn từ ảnh này. Đưa gần hơn, đủ sáng hơn.");
        return done;
      } catch (error) {
        trackLedger({ targetKey: budgetKey, latencyMs: Math.round(performance.now() - started), imageBytes, outcome: "error" });
        if (mounted.current)
          setMessage(error instanceof Error && error.message ? error.message : friendlyError(error));
        return false;
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [cloudUsage.perHour, consent, finishWithFields],
  );

  /** One continuous-scan tick: sharpness → codes → local OCR → vote. */
  const scanTick = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !mounted.current || resultRef.current || busyRef.current) return;
    const canvas = sourceCanvas(video);
    if (!canvas) return;
    sharpRef.current = frameSharpness(canvas) >= CLARITY_THRESHOLD;
    if (!sharpRef.current) return;
    const gray = toGray(canvas);
    if (gray) {
      const sig = sceneSignature(gray);
      if (motionScore(prevSigRef.current, sig) > SCENE_CHANGE_RESET) voteRef.current = null;
      prevSigRef.current = sig;
    }
    // Layer 1: QR/barcodes (free, local) — a shop QR opens the profile at once.
    if (tickCountRef.current++ % CODE_TICK_EVERY === 0) {
      const codes = await detectCodes(canvas);
      for (const code of codes) {
        const id = resolveVehicleQr(code, window.location.origin);
        if (id) {
          // A printed sticker can outlive the record — verify the identity in
          // the database (free RPC, RLS applies) before the success "tít".
          let verified = false;
          try {
            verified = (await api.call<{ id?: string }>("get_vehicle", { p_id: id }))?.id === id;
          } catch {
            verified = false;
          }
          if (!verified) {
            if (mounted.current) setLiveHint("QR trỏ tới mã xe không còn hồ sơ hợp lệ — kiểm tra lại thủ công.");
            missRef.current++;
            return;
          }
          if (settings.sound) scanTone("match");
          setMetrics({ ocrMs: 0, lookupMs: 0, cloudMs: 0, via: "code" });
          await stopCamera();
          navigate(`/vehicles/${id}`);
          return;
        }
      }
    }
    if (!settings.localOcr) {
      missRef.current++;
    } else {
      // Layer 2: on-device OCR with stable-frame voting.
      const read = await localReadFrame(canvas);
      const key = read ? read.license_plate || read.frame_number : "";
      const vote = pushVote(voteRef.current, key, read?.plateConfidence ?? 0);
      voteRef.current = vote.state;
      if (key && !vote.settled) setLiveHint(`Đang đọc ${key} — giữ yên một chút…`);
      if (vote.settled && read) {
        const frame = await captureVideoFrame(video);
        const done = await finishWithFields(
          { license_plate: read.license_plate, frame_number: read.frame_number, engine_number: read.engine_number },
          "local",
          frame,
          { ocrMs: read.ocrMs, cloudMs: 0 },
        );
        if (done) return;
      }
      if (key) missRef.current = 0;
      else missRef.current++;
    }
    // Layer 3 (opt-in): one automatic budgeted cloud read after a starvation
    // streak — this is the ONLY place continuous scanning may ever cost money,
    // and it is capped per hour and switchable to manual/off in settings.
    if (missRef.current >= AUTO_FALLBACK_MISSES) {
      missRef.current = 0;
      if (settings.cloudMode === "auto") {
        const frame = await captureVideoFrame(video);
        if (frame) await cloudRead(frame, "auto", true);
      } else if (settings.cloudMode === "manual" && mounted.current) {
        setLiveHint("Máy chưa đọc được — bấm “AI đọc ảnh” nếu cần (có giới hạn lượt).");
      }
    }
  }, [cloudRead, finishWithFields, navigate, settings.cloudMode, settings.localOcr, settings.sound, stopCamera]);

  // Adaptive sequential loop — one pass in flight at a time, never a fixed
  // interval pile-up, so the UI thread stays free for the camera preview.
  useEffect(() => {
    if (!running || !settings.autoCapture || result) return;
    let cancelled = false;
    let timer = 0;
    const step = async () => {
      if (cancelled) return;
      try {
        await scanTick();
      } catch {
        /* A bad frame is not worth breaking the loop over. */
      }
      if (!cancelled && !resultRef.current)
        timer = window.setTimeout(() => void step(), nextTickMs({ busy: busyRef.current, missStreak: missRef.current, sharp: sharpRef.current }));
    };
    timer = window.setTimeout(() => void step(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [running, settings.autoCapture, result, scanTick]);

  /** Manual "Chụp & nhận diện": one decisive local read, cloud per setting. */
  const shootNow = useCallback(async () => {
    const video = videoRef.current;
    if (!video || busyRef.current) return;
    const frame = await captureVideoFrame(video);
    if (!frame) {
      setMessage("Chưa chụp được khung hình nào. Thử lại hoặc chọn ảnh từ thư viện.");
      return;
    }
    if (settings.localOcr && ocrStage() !== "unavailable") {
      busyRef.current = true;
      setBusy(true);
      try {
        const read = await localReadFrame(video);
        if (read && (await finishWithFields({ license_plate: read.license_plate, frame_number: read.frame_number, engine_number: read.engine_number }, "local", frame, { ocrMs: read.ocrMs, cloudMs: 0 })))
          return;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }
    if (settings.cloudMode !== "off") {
      const fallbackKey = `manual:${new Date().toISOString().slice(0, 16)}`;
      if (!(await cloudRead(frame, fallbackKey, false)) && !busyRef.current) return;
    } else {
      setMessage("Chưa đọc được gì từ ảnh này — thử đưa sát hơn, đủ sáng hơn, hoặc nhập thủ công.");
    }
  }, [cloudRead, finishWithFields, settings.cloudMode, settings.localOcr]);

  /** Explicit AI button (manual mode): always user-initiated, always budgeted. */
  const aiReadNow = useCallback(async () => {
    const video = videoRef.current;
    if (!video || busyRef.current) return;
    const frame = await captureVideoFrame(video);
    if (!frame) {
      setMessage("Chưa chụp được khung hình nào. Thử lại.");
      return;
    }
    await cloudRead(frame, `manual:${new Date().toISOString().slice(0, 16)}`, false);
  }, [cloudRead]);

  const pickFromLibrary = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const frame = await captureFromFile(file);
    if (!frame) {
      setMessage("Không đọc được tệp ảnh này. Thử ảnh JPG hoặc PNG khác.");
      return;
    }
    if (settings.localOcr) {
      busyRef.current = true;
      setBusy(true);
      try {
        const canvas = await dataUrlToCanvas(frame.dataUrl);
        const read = canvas ? await localReadFrame(canvas) : null;
        if (read && (await finishWithFields({ license_plate: read.license_plate, frame_number: read.frame_number, engine_number: read.engine_number }, "local", frame, { ocrMs: read.ocrMs, cloudMs: 0 })))
          return;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }
    if (settings.cloudMode !== "off") await cloudRead(frame, `library:${new Date().toISOString().slice(0, 16)}`, false);
    else if (mounted.current)
      setMessage(settings.localOcr ? "Ảnh này chưa đọc được gì — thử rõ hơn hoặc nhập tay." : "Bật OCR trên máy hoặc AI để đọc ảnh thư viện.");
  };

  const removePhoto = (index: number) =>
    setResult((prev) =>
      prev ? { ...prev, photos: prev.photos.filter((_, i) => i !== index) } : prev,
    );

  const rescan = () => {
    commitResult(null);
    voteRef.current = null;
    missRef.current = 0;
    setMetrics(null);
    void startCamera();
  };

  const toIntake = () => {
    if (!result) return;
    saveRecognitionDraft(profile?.id, result);
    navigate("/intake", { state: { recognition: result } });
  };

  if (!operate)
    return (
      <Card>
        <p className="muted">Camera thông minh cần quyền vận hành (STAFF trở lên).</p>
      </Card>
    );

  // Narrowed once per render so the action callbacks keep the discriminated
  // union type instead of re-widening inside closures. Consent gates the CLOUD
  // path only — a local (or legacy pre-contract) read never shares an image,
  // so hiding its verdict behind the checkbox would be a bug.
  const shown = result && (consent || result.source !== "cloud") ? result : null;
  const match = shown?.match;
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

  return (
    <Card>
      <h2 className="section-title">
        <Sparkles size={16} aria-hidden="true" />
        <span>Nhận diện xe</span>
      </h2>
      <p className="muted small">
        Chĩa camera vào xe hoặc biển số — đọc ngay trên máy, đối chiếu kho và mở
        đúng hồ sơ, hoặc transfer thông tin sang Thu xe tốc ký.
      </p>
      <div className="smartcam-stage">
        <video
          ref={videoRef}
          className={`smartcam-video${running ? "" : " hidden"}`}
          playsInline
          muted
          aria-label="Hình camera trực tiếp"
        />
        {running && liveHint && (
          <div className="smartcam-hint" role="status">
            {liveHint}
          </div>
        )}
        {running && <div className="smartcam-guide" aria-hidden="true" />}
      </div>
      <p className="smartcam-engine muted small">
        <Cpu size={13} aria-hidden="true" /> {settings.localOcr ? OCR_STAGE_LABELS[engine] : "OCR trên máy: tắt"}
        {settings.cloudMode !== "off" && ` · AI: ${cloudUsage.callsToday} lượt hôm nay (giới hạn ${cloudUsage.perHour}/giờ)`}
      </p>
      <div className="row smartcam-controls">
        <Button type="button" onClick={() => void (running ? stopCamera() : startCamera())}>
          <Camera size={16} /> {running ? "Tắt camera" : "Mở camera"}
        </Button>
        <Button type="button" disabled={!running || busy} onClick={() => void shootNow()}>
          <ScanLine size={16} /> Chụp & nhận diện
        </Button>
        {settings.cloudMode === "manual" && (
          <Button type="button" variant="secondary" disabled={!running || busy} onClick={() => void aiReadNow()}>
            <Sparkles size={16} /> AI đọc ảnh
          </Button>
        )}
        <label className="button secondary upload-button">
          <Images size={16} /> Ảnh thư viện
          <input
            aria-label="Chọn ảnh xe từ thư viện"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => void pickFromLibrary(event)}
          />
        </label>
      </div>
      <div className="smartcam-settings">
        <label className="row">
          <input
            type="checkbox"
            checked={settings.autoCapture}
            onChange={(event) => updateSettings({ autoCapture: event.target.checked })}
          />
          Quét liên tục khi mở camera
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.localOcr}
            onChange={(event) => updateSettings({ localOcr: event.target.checked })}
          />
          Đọc biển số/số khung trên máy (miễn phí, không gửi ảnh)
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.sound}
            onChange={(event) => updateSettings({ sound: event.target.checked })}
          />
          Kêu "tít" khi xác khớp duy nhất một xe
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.autoOpen}
            onChange={(event) => updateSettings({ autoOpen: event.target.checked })}
          />
          Tự mở hồ sơ khi khớp duy nhất
        </label>
        <Field label="Khi máy không đọc được, dùng AI trên mây">
          <select
            value={settings.cloudMode}
            onChange={(event) => updateSettings({ cloudMode: event.target.value as CameraSettings["cloudMode"] })}
          >
            <option value="auto">Tự động thử 1 lần (có giới hạn lượt)</option>
            <option value="manual">Chỉ khi bấm "AI đọc ảnh"</option>
            <option value="off">Không dùng AI (0 chi phí)</option>
          </select>
        </Field>
      </div>
      <label className="row smartcam-consent">
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(event) => setConsent(event.target.checked)}
        />
        Cho phép gửi ảnh đang chụp tới dịch vụ AI khi cần. OCR trên máy không
        cần quyền này vì ảnh không rời khỏi thiết bị.
      </label>
      {busy && (
        <p role="status" className="notice">
          Đang nhận diện…
        </p>
      )}
      {!busy && message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {result && !consent && result.source === "cloud" && (
        <p className="notice">
          Bật đồng ý gửi ảnh ở trên để Cà Rem được phép đọc ảnh xe bằng AI.
        </p>
      )}
      {shown && match && (
        <div className="smartcam-result">
          {match.state === "unique" && (
            <>
              <p className="smartcam-verdict ok">
                <BadgeCheck size={16} aria-hidden="true" />
                <span>
                  Đã xác khớp xe trong kho: {match.vehicle.brand}{" "}
                  {match.vehicle.model}
                  {match.vehicle.license_plate ? ` · ${match.vehicle.license_plate}` : ""} ·{" "}
                  {VEHICLE_STATUS_LABELS[match.vehicle.status] ?? match.vehicle.status}
                </span>
              </p>
              <ResultChips recognition={shown} />
              <div className="row smartcam-actions">
                <Button
                  type="button"
                  onClick={() => navigate(`/vehicles/${match.vehicle.id}`)}
                >
                  Mở hồ sơ xe
                </Button>
                <Button type="button" variant="secondary" onClick={rescan}>
                  Quét tiếp
                </Button>
              </div>
            </>
          )}
          {match.state === "none" && (
            <>
              <p className="smartcam-verdict">
                <CircleAlert size={16} aria-hidden="true" />
                <span>Không tìm thấy xe này trong kho. Có thể là xe mới về.</span>
              </p>
              <ResultChips recognition={shown} />
              <div className="row smartcam-actions">
                <Button type="button" onClick={toIntake}>
                  Thu xe mới
                </Button>
                <Button type="button" variant="secondary" onClick={rescan}>
                  Quét lại
                </Button>
              </div>
            </>
          )}
          {(match.state === "ambiguous" || match.state === "conflict") && (
            <>
              <p className="smartcam-verdict warn">
                <CircleAlert size={16} aria-hidden="true" />
                <span>
                  {match.state === "conflict"
                    ? "Biển số và số khung chỉ tới các xe khác nhau — cần người xác minh."
                    : "Nhiều hơn một xe trùng thông tin — cần chọn đúng xe."}
                </span>
              </p>
              <Field label="Xe ứng viên (chọn xe đúng)">
                <div className="smartcam-candidates">
                  {match.candidates.map((row) => (
                    <button
                      type="button"
                      key={row.id}
                      className="smartcam-candidate"
                      onClick={() => navigate(`/vehicles/${row.id}`)}
                    >
                      <strong>
                        {row.brand} {row.model}
                      </strong>
                      <span>{row.license_plate || row.internal_code}</span>
                      <small>{VEHICLE_STATUS_LABELS[row.status] ?? row.status}</small>
                    </button>
                  ))}
                </div>
              </Field>
              <ResultChips recognition={shown} />
              <div className="row smartcam-actions">
                <Button type="button" variant="secondary" onClick={toIntake}>
                  Thu xe mới (sau khi đã kiểm tra)
                </Button>
                <Button type="button" variant="secondary" onClick={rescan}>
                  Quét lại
                </Button>
              </div>
            </>
          )}
          {!!shown.photos.length && (
            <div className="smartcam-photos" aria-label="Ảnh kèm theo bản nháp">
              {shown.photos.map((photo, index) => (
                <span className="smartcam-photo" key={photo.slice(-24)}>
                  <img src={photo} alt={`Ảnh quét ${index + 1}`} />
                  <button type="button" aria-label={`Bỏ ảnh ${index + 1}`} onClick={() => removePhoto(index)}>
                    <Trash2 size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {metrics && (
            <p className="muted small" aria-label="Chỉ số lượt quét">
              Nguồn: {metrics.via === "cloud" ? "AI trên mây" : "OCR trên máy"} · OCR {metrics.ocrMs}ms · AI{" "}
              {metrics.cloudMs}ms · tra kho {metrics.lookupMs}ms
              {heap ? ` · bộ nhớ ${Math.round(heap.usedJSHeapSize / 1048576)} MB` : ""}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
