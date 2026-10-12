import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { useDialog } from "@/lib/useDialog";
import {
  BadgeCheck,
  Camera,
  CircleAlert,
  Cpu,
  Images,
  Power,
  QrCode,
  RotateCcw,
  ScanLine,
  ScanSearch,
  Sparkles,
  SwitchCamera,
  Zap,
  ZapOff,
  ZoomIn,
} from "lucide-react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { canManage, canOperate } from "@/lib/permissions";
import { resolveVehicleQr } from "@/lib/qrcode";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button, Card } from "@/components/ui";
import {
  classifyFields,
  normalizeScan,
  normalizeScanRisks,
  saveRecognitionDraft,
  type Recognition,
  type ScannedKey,
  type VehicleMatch,
} from "@/lib/smartcam/recognition";
import {
  applyContinuousFocus,
  applyTorch,
  applyZoom,
  cameraFlipLabel,
  captureFromFile,
  captureVideoFrame,
  currentZoomLevel,
  dataUrlToCanvas,
  frameSharpness,
  loadCameraSettings,
  nextCameraPlan,
  prepareScanAudio,
  saveCameraSettings,
  scanTone,
  supportsContinuousFocus,
  torchMode,
  torchStateFromSettings,
  viewfinderCanvas,
  visibleCameraCanvas,
  zoomCapability,
  type CameraSettings,
  type CaptureMode,
  type CapturedFrame,
  type TorchMode,
  type ZoomCapability,
} from "@/lib/smartcam/capture";
import { lookupIdentityDocument, lookupScan } from "@/lib/smartcam/lookup";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";
import {
  ensureOcrWorker,
  localReadFrame,
  localReadIdentity,
  onOcrStageChange,
  ocrStage,
  releaseOcrWorker,
  type OcrStage,
  type LocalRead,
} from "@/lib/smartcam/local/ocr";
import { parseIdentityDocumentQr } from "@/lib/smartcam/local/identity";
import { detectCodes } from "@/lib/smartcam/local/barcodes";
import {
  motionScore,
  sceneSignature,
  toGray,
  analyzeFrame,
} from "@/lib/smartcam/local/frames";
import {
  type FrameAnalysis,
  type DetectedRegion,
} from "@/lib/smartcam/local/regions";
import {
  appendScanSample,
  bestScanSample,
  type ScanSample,
} from "@/lib/smartcam/local/frameWindow";
import {
  nextTickMs,
  pushVote,
  type VoteState,
} from "@/lib/smartcam/local/voting";
import {
  cloudAllowed,
  loadLedger,
  recordCall,
  saveLedger,
  summarize,
  type CloudCall,
} from "@/lib/smartcam/local/budget";

const FIELD_LABELS: Record<ScannedKey, string> = {
  license_plate: "Biển số",
  frame_number: "Số khung",
  vehicle_type: "Loại xe",
  color: "Màu",
  year: "Năm",
};
const STATUS_LABELS = {
  IN_STOCK: "còn kho",
  RESERVED: "đã giữ chỗ",
  SOLD: "đã bán",
} as Record<string, string>;
const MODES = [
  {
    value: "scan",
    title: "Biển số / số khung",
    description: "Tự quét liên tục, có tiếng tít",
    icon: ScanLine,
  },
  {
    value: "photo",
    title: "Nhận diện ảnh xe",
    description: "Loại xe, màu và năm từ ảnh",
    icon: Camera,
  },
  {
    value: "qr",
    title: "QR xe",
    description: "Quét mã để mở xe trong kho",
    icon: QrCode,
  },
  {
    value: "identity",
    title: "CCCD",
    description: "Tìm xe đang lưu căn cước này",
    icon: ScanSearch,
  },
] as const;
const OCR_LABELS: Record<OcrStage, string> = {
  idle: "Đọc trên máy sẵn sàng khi mở camera",
  loading: "Đang chuẩn bị bộ đọc trên máy…",
  ready: "Đọc trên máy đã sẵn sàng",
  unavailable: "Bộ đọc trên máy chưa tải được. Có thể bật AI để đọc ảnh.",
};

function ResultChips({ recognition }: { recognition: Recognition }) {
  const entries = (Object.keys(FIELD_LABELS) as ScannedKey[]).filter(
    (key) => recognition.fields[key],
  );
  const risky = entries.some((key) => recognition.statuses[key] !== "VERIFIED");
  return (
    <div className="smartcam-fields-group">
      {risky && (
        <p className="smartcam-fields-head tone-danger">
          Chữ tô đỏ cần kiểm tra lại với ảnh gốc.
        </p>
      )}
      <dl className="smartcam-fields" aria-label="Các trường nhận diện được">
        {entries.map((key) => {
          const status = recognition.statuses[key];
          const indexes =
            key === "license_plate" || key === "frame_number"
              ? (recognition.riskCharacters?.[key] ?? [])
              : [];
          const wholeRisk = status !== "VERIFIED" && indexes.length === 0;
          return (
            <div
              key={key}
              className={
                "smartcam-field " +
                (wholeRisk ? "tone-danger" : "tone-ok") +
                (key === "frame_number" ? " wide" : "")
              }
            >
              <dt>{FIELD_LABELS[key]}</dt>
              <dd>
                {[...recognition.fields[key]].map((char, index) =>
                  indexes.includes(index) ? (
                    <mark
                      className="smartcam-risk-char"
                      title="Ký tự có thể đọc nhầm"
                      key={index}
                    >
                      {char}
                    </mark>
                  ) : (
                    <span key={index}>{char}</span>
                  ),
                )}
                <small className="sr-only">
                  {status === "VERIFIED" ? "đã xác khớp" : "cần kiểm tra"}
                </small>
              </dd>
            </div>
          );
        })}
      </dl>
      {recognition.fields.year ? (
        <p className="muted small">
          Năm nhận diện từ ảnh cần đối chiếu giấy tờ xe.
        </p>
      ) : recognition.fields.vehicle_type ? (
        <p className="muted small">Chưa xác định chắc năm từ ảnh này.</p>
      ) : null}
    </div>
  );
}

export default function SmartVehicleScan() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const starting = useRef(false);
  const switching = useRef(false);
  const changingTorch = useRef(false);
  const processing = useRef(false);
  const busyRef = useRef(false);
  const cloudPending = useRef(false);
  const resultRef = useRef<Recognition | null>(null);
  const photoDraft = useRef<Recognition | null>(null);
  const voteRef = useRef<VoteState>(null);
  const misses = useRef(0);
  const previousScene = useRef<Float32Array | null>(null);
  const frameWindow = useRef<
    ScanSample<{ canvas: HTMLCanvasElement; read: LocalRead | null }>[]
  >([]);
  const [focusRegions, setFocusRegions] = useState<DetectedRegion[]>([]);
  const ledger = useRef<CloudCall[]>(loadLedger());
  const scanSession = useRef(0);
  const [settings, setSettings] = useState<CameraSettings>(loadCameraSettings);
  const [running, setRunning] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [torchBusy, setTorchBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [liveHint, setLiveHint] = useState("");
  const [result, setResult] = useState<Recognition | null>(null);
  const [identityMatch, setIdentityMatch] = useState<VehicleMatch | null>(null);
  const identityMatchRef = useRef<VehicleMatch | null>(null);
  const [photoReady, setPhotoReady] = useState(false);
  const [openFollowup, setOpenFollowup] = useState(false);
  const [frozenPreview, setFrozenPreview] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoDialogRef = useDialog(!!photoPreview, () => setPhotoPreview(null));
  const [engine, setEngine] = useState<OcrStage>(ocrStage());
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchKind, setTorchKind] = useState<TorchMode>("none");
  const [torchOn, setTorchOn] = useState(false);
  const [zoomRange, setZoomRange] = useState<ZoomCapability | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [zoomBusy, setZoomBusy] = useState(false);
  const [tapFocus, setTapFocus] = useState<{ x: number; y: number } | null>(null);
  const tapFocusTimeoutRef = useRef<number | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [activeCameraId, setActiveCameraId] = useState("");
  const [activeFacing, setActiveFacing] = useState<"environment" | "user">(
    "environment",
  );
  const [cloudUsage, setCloudUsage] = useState(() =>
    summarize(ledger.current, Date.now()),
  );
  const aiEnabled = settings.cloudMode === "auto";
  const operate = canOperate(profile);
  const identityAllowed = canManage(profile);
  const mode =
    settings.mode === "identity" && !identityAllowed ? "scan" : settings.mode;
  const isCurrent = useCallback(
    (token: number) => mounted.current && token === epoch.current,
    [],
  );

  const commitResult = useCallback((value: Recognition | null) => {
    resultRef.current = value;
    setResult(value);
  }, []);

  const stopCamera = useCallback(async () => {
    epoch.current++;
    const stream = streamRef.current;
    streamRef.current = null;
    frameWindow.current = [];
    if (videoRef.current) videoRef.current.srcObject = null;
    if (mounted.current) {
      setRunning(false);
      setTorchOn(false);
      setTorchSupported(false);
      setZoomRange(null);
      setZoomLevel(1);
      setTapFocus(null);
      setFocusRegions([]);
    }
    if (stream) {
      const track = stream.getVideoTracks()[0];
      try {
        if (track && torchStateFromSettings(track))
          await applyTorch(track, torchMode(track.getCapabilities?.()), false);
      } catch {
        /* Device may reset its torch before closing. */
      }
      stream.getTracks().forEach((track) => track.stop());
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const scanEpoch = epoch;
    const unsubscribe = onOcrStageChange(setEngine);
    const externalStop = () => {
      void stopCamera();
    };
    window.addEventListener("xe:smartcam:stop", externalStop);
    return () => {
      mounted.current = false;
      scanEpoch.current++;
      unsubscribe();
      window.removeEventListener("xe:smartcam:stop", externalStop);
      if (tapFocusTimeoutRef.current) {
        window.clearTimeout(tapFocusTimeoutRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      releaseOcrWorker();
    };
  }, [stopCamera]);

  const startCamera = useCallback(
    async (
      plan?: { facing: "environment" | "user" } | { deviceId: string },
    ) => {
      if (starting.current || streamRef.current || busyRef.current) return;
      prepareScanAudio();
      starting.current = true;
      setCameraBusy(true);
      const token = ++epoch.current;
      scanSession.current++;
      setMessage("");
      setLiveHint("");
      setFrozenPreview(null);
      if (resultRef.current) photoDraft.current = null;
      commitResult(null);
      identityMatchRef.current = null;
      setIdentityMatch(null);
      setPhotoReady(false);
      voteRef.current = null;
      misses.current = 0;
      previousScene.current = null;
      frameWindow.current = [];
      setFocusRegions([]);
      const facing = plan && "facing" in plan ? plan.facing : activeFacing;
      const deviceId = plan && "deviceId" in plan ? plan.deviceId : undefined;
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("Camera không khả dụng");
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: deviceId
              ? { deviceId: { exact: deviceId } }
              : {
                  facingMode: { ideal: facing },
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                },
            audio: false,
          });
        } catch (error) {
          if (
            !deviceId ||
            (error instanceof DOMException && error.name === "NotAllowedError")
          )
            throw error;
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: facing } },
            audio: false,
          });
        }
        if (!isCurrent(token)) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        if (track) {
          const sync = () => {
            if (!mounted.current || streamRef.current !== stream) return;
            const actual = track.getSettings();
            setActiveCameraId(actual.deviceId ?? "");
            setActiveFacing(
              actual.facingMode === "user"
                ? "user"
                : actual.facingMode === "environment"
                  ? "environment"
                  : facing,
            );
            const caps = track.getCapabilities?.();
            setTorchKind(torchMode(caps));
            setTorchSupported(torchMode(caps) !== "none");
            setTorchOn(torchStateFromSettings(track));
            const zCap = zoomCapability(caps);
            setZoomRange(zCap);
            setZoomLevel(currentZoomLevel(track));
          };
          sync();
          track.addEventListener("constraintchange", sync);

          // Proactively request continuous auto-focus if hardware supports it
          try {
            const caps = track.getCapabilities?.();
            if (supportsContinuousFocus(caps)) {
              void applyContinuousFocus(track).catch(() => undefined);
            }
          } catch {
            /* focusMode not supported */
          }
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        if (!isCurrent(token)) {
          if (streamRef.current === stream) {
            stream.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
          }
          return;
        }
        setRunning(true);
        if (mode === "scan" || mode === "identity") void ensureOcrWorker();
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (isCurrent(token))
            setCameras(
              devices.filter((device) => device.kind === "videoinput"),
            );
        } catch {
          /* Lens switching can use facingMode without enumeration. */
        }
      } catch {
        if (isCurrent(token))
          setMessage(
            "Không mở được camera. Kiểm tra quyền camera hoặc chọn ảnh từ thư viện.",
          );
      } finally {
        starting.current = false;
        if (mounted.current) setCameraBusy(false);
      }
    },
    [activeFacing, commitResult, isCurrent, mode],
  );

  useEffect(() => {
    if (!openFollowup || mode !== "scan") return;
    setOpenFollowup(false);
    void startCamera();
  }, [mode, openFollowup, startCamera]);

  const finishIdentity = useCallback(
    async (idNumber: string, token: number, uncertain: number[] = []) => {
      if (!identityAllowed || !isCurrent(token) || !/^\d{12}$/.test(idNumber))
        return false;
      if (uncertain.length) {
        setMessage(
          "Số CCCD có ký tự chưa rõ. Đưa căn cước gần hơn hoặc dùng ảnh rõ hơn để tìm đúng xe.",
        );
        return false;
      }
      const match = await lookupIdentityDocument(idNumber);
      if (!isCurrent(token)) return false;
      scanTone(match.state === "unique" ? "match" : "review");
      identityMatchRef.current = match;
      setIdentityMatch(match);
      await stopCamera();
      if (match.state === "unique") navigate("/vehicles/" + match.vehicle.id);
      return true;
    },
    [identityAllowed, isCurrent, navigate, stopCamera],
  );

  const finishWithFields = useCallback(
    async (
      draft: Record<string, unknown>,
      via: "local" | "cloud",
      frame: CapturedFrame | null,
      token: number,
    ) => {
      if (!isCurrent(token)) return false;
      const filtered = { ...draft };
      if (mode === "photo") {
        filtered.license_plate = null;
        filtered.frame_number = null;
      }
      if (mode === "scan") {
        filtered.vehicle_type = null;
        filtered.color = null;
        filtered.year = null;
      }
      const current = normalizeScan(filtered);
      if (!Object.values(current).some(Boolean)) return false;
      const fields =
        photoDraft.current && mode === "scan"
          ? { ...photoDraft.current.fields }
          : { ...current };
      for (const key of Object.keys(current) as ScannedKey[])
        if (current[key]) fields[key] = current[key];
      const riskCharacters = { ...photoDraft.current?.riskCharacters };
      const currentRisks = normalizeScanRisks(filtered, current);
      for (const key of ["license_plate", "frame_number"] as const) {
        if (current[key]) {
          delete riskCharacters[key];
          if (currentRisks[key]) riskCharacters[key] = currentRisks[key];
        }
      }
      const match =
        mode === "photo"
          ? ({ state: "none" } as const)
          : await lookupScan(fields);
      if (!isCurrent(token)) return false;
      const recognition: Recognition = {
        version: 1,
        scannedAt: new Date().toISOString(),
        fields,
        statuses: classifyFields(fields, match, riskCharacters),
        match,
        photos: [
          ...(photoDraft.current?.photos ?? []),
          ...(frame ? [frame.dataUrl] : []),
        ].slice(0, 4),
        source: via,
        riskCharacters,
      };
      const uncertain = Object.values(riskCharacters).some(
        (indexes) => indexes && indexes.length > 0,
      );
      scanTone(
        uncertain || match.state === "conflict" || match.state === "ambiguous"
          ? "review"
          : "match",
      );
      commitResult(recognition);
      saveRecognitionDraft(profile?.id, recognition);
      const continuingPhoto = !!photoDraft.current?.fields.vehicle_type;
      photoDraft.current = recognition;
      if (mode === "photo") setPhotoReady(true);
      setLiveHint("");
      await stopCamera();
      const safeIdentity = (["license_plate", "frame_number"] as const).every(
        (key) => !fields[key] || recognition.statuses[key] === "VERIFIED",
      );
      if (
        mode === "scan" &&
        match.state === "unique" &&
        safeIdentity &&
        !uncertain &&
        !continuingPhoto
      )
        navigate("/vehicles/" + match.vehicle.id);
      return true;
    },
    [commitResult, isCurrent, mode, navigate, profile?.id, stopCamera],
  );

  const cloudRead = useCallback(
    async (frame: CapturedFrame, token: number) => {
      if (!aiEnabled || !isCurrent(token) || cloudPending.current) return false;
      const budgetKey =
        "camera:" + mode + ":" + scanSession.current + ":" + token;
      const allowed = cloudAllowed(ledger.current, Date.now(), budgetKey);
      if (!allowed.ok) {
        if (allowed.reason === "HOURLY_LIMIT")
          setMessage(
            "Đã dùng hết lượt AI trong giờ này. Quét trên máy và QR vẫn hoạt động.",
          );
        return false;
      }
      const started = performance.now();
      cloudPending.current = true;
      let outcome: "ok" | "error" = "ok";
      setBusy(true);
      busyRef.current = true;
      try {
        const response = await api.assist<{
          kind: string;
          draft?: Record<string, unknown>;
        }>({
          task: "vehicle_scan",
          consent: true,
          scan_mode:
            mode === "photo"
              ? "vehicle"
              : mode === "identity"
                ? "identity"
                : "identifiers",
          ...(mode === "scan" ? { scan_target: "both" as const } : {}),
          image: { mime_type: "image/jpeg", base64: frame.jpegBase64 },
        });
        if (!isCurrent(token)) return false;
        const draft = response?.kind === "draft" ? (response.draft ?? {}) : {};
        if (mode === "identity") {
          const id =
            typeof draft.identity_number === "string"
              ? draft.identity_number
              : "";
          const done = await finishIdentity(id, token);
          if (!done && isCurrent(token))
            setMessage(
              "Chưa đọc rõ số CCCD. Đưa gần hơn hoặc chọn ảnh căn cước rõ hơn.",
            );
          return done;
        }
        const done = await finishWithFields(draft, "cloud", frame, token);
        if (!done && isCurrent(token))
          setMessage(
            "Chưa đọc được thông tin rõ ràng. Đưa đúng đối tượng vào khung hoặc chọn ảnh rõ hơn.",
          );
        return done;
      } catch (error) {
        outcome = "error";
        if (isCurrent(token)) setMessage(friendlyError(error));
        return false;
      } finally {
        ledger.current = recordCall(ledger.current, {
          ts: Date.now(),
          targetKey: budgetKey,
          latencyMs: Math.round(performance.now() - started),
          imageBytes: Math.round((frame.jpegBase64.length * 3) / 4),
          outcome,
        });
        saveLedger(ledger.current);
        cloudPending.current = false;
        busyRef.current = false;
        if (mounted.current) {
          setBusy(false);
          setCloudUsage(summarize(ledger.current, Date.now()));
        }
      }
    },
    [aiEnabled, finishIdentity, finishWithFields, isCurrent, mode],
  );

  const readCodes = useCallback(
    async (canvas: HTMLCanvasElement, token: number) => {
      const codes = await detectCodes(canvas);
      if (!isCurrent(token)) return false;
      if (mode === "identity") {
        for (const code of codes) {
          const identity = parseIdentityDocumentQr(code);
          if (
            identity &&
            (await finishIdentity(
              identity.document_number,
              token,
              identity.uncertainCharacters,
            ))
          )
            return true;
        }
        return false;
      }
      const ids = [
        ...new Set(
          codes
            .map((code) => resolveVehicleQr(code, window.location.origin))
            .filter(Boolean),
        ),
      ];
      if (ids.length !== 1) {
        if (codes.length)
          setLiveHint(
            ids.length > 1
              ? "Có nhiều mã xe. Đưa một mã QR vào khung."
              : "QR này không phải mã xe của Cà Rem.",
          );
        return false;
      }
      const id = ids[0];
      const vehicle = await api.call<{ id?: string }>("get_vehicle", {
        p_id: id,
      });
      if (!isCurrent(token)) return false;
      if (vehicle?.id !== id) {
        setLiveHint("Mã QR này chưa có hồ sơ xe hợp lệ trong kho.");
        return false;
      }
      scanTone("match");
      await stopCamera();
      navigate("/vehicles/" + id);
      return true;
    },
    [finishIdentity, isCurrent, mode, navigate, stopCamera],
  );

  const scanTick = useCallback(async () => {
    if (
      !streamRef.current ||
      starting.current ||
      switching.current ||
      processing.current ||
      busyRef.current ||
      resultRef.current ||
      identityMatchRef.current
    )
      return;
    const video = videoRef.current;
    if (!video) return;
    const canvas =
      mode === "scan" ? visibleCameraCanvas(video) : viewfinderCanvas(video);
    if (!canvas) return;
    const token = epoch.current;
    processing.current = true;
    try {
      if (mode === "qr" || mode === "identity") {
        if (await readCodes(canvas, token)) return;
        if (mode === "qr") return;
      }
      if (!isCurrent(token)) return;
      let analysis: FrameAnalysis | null = null;
      if (mode === "scan") {
        analysis = analyzeFrame(canvas);
        setFocusRegions(analysis?.regions.slice(0, 2) ?? []);
        setLiveHint(analysis?.quality.message ?? "Đang tìm vùng chữ để đọc…");
      }
      if (mode !== "scan" && frameSharpness(canvas) < 0.35) {
        if (isCurrent(token))
          setLiveHint("Giữ yên, đưa gần hơn và tăng ánh sáng để đọc rõ.");
        return;
      }
      const gray = toGray(canvas);
      if (gray) {
        const sig = sceneSignature(gray);
        if (motionScore(previousScene.current, sig) > 0.35) {
          voteRef.current = null;
          frameWindow.current = [];
          misses.current = 0;
        }
        previousScene.current = sig;
      }
      if (mode === "identity") {
        const read = await localReadIdentity(canvas);
        if (!isCurrent(token)) return;
        const vote = pushVote(
          voteRef.current,
          read?.document_number ?? "",
          read?.confidence ?? 0,
        );
        voteRef.current = vote.state;
        if (
          vote.settled &&
          read &&
          (await finishIdentity(
            read.document_number,
            token,
            read.uncertainCharacters,
          ))
        )
          return;
        if (read) setLiveHint("Đang kiểm tra số CCCD — giữ yên căn cước…");
        misses.current++;
      } else {
        const read = await localReadFrame(canvas, {
          analysis: analysis ?? undefined,
        });
        if (!isCurrent(token)) return;
        const key = read ? read.license_plate + "|" + read.frame_number : "";
        const hasIdentifier = !!(read?.license_plate || read?.frame_number);
        frameWindow.current = appendScanSample(frameWindow.current, {
          key: hasIdentifier ? key : "",
          analysis,
          value: { canvas, read },
        });
        const confidence = read?.license_plate
          ? read.plateConfidence
          : (read?.frameConfidence ?? 0);
        const vote = pushVote(
          voteRef.current,
          hasIdentifier ? key : "",
          confidence,
        );
        voteRef.current = vote.state;
        if (hasIdentifier)
          setLiveHint(
            "Đang đọc " +
              (read?.license_plate || read?.frame_number) +
              " — giữ yên…",
          );
        if (vote.settled && read) {
          const best = bestScanSample(frameWindow.current)?.value;
          const chosen = best?.read ?? read;
          // A clearer image must not erase warnings observed on another agreeing frame.
          const warnings = {
            license_plate: [] as number[],
            frame_number: [] as number[],
          };
          for (const field of ["license_plate", "frame_number"] as const) {
            warnings[field] = [
              ...new Set(
                frameWindow.current.flatMap(
                  (sample) => sample.value.read?.warnings[field] ?? [],
                ),
              ),
            ];
          }
          const frame = await captureVideoFrame(best?.canvas ?? canvas);
          if (
            await finishWithFields(
              { ...chosen, uncertain_characters: warnings },
              "local",
              frame,
              token,
            )
          )
            return;
        }
        misses.current++;
      }
      if (isCurrent(token) && misses.current >= 4 && aiEnabled) {
        misses.current = 0;
        // Without an agreed identifier, an older sharp frame can belong to a
        // different vehicle. Cloud assistance reads this current view only.
        const frame = await captureVideoFrame(canvas);
        if (frame) await cloudRead(frame, token);
      }
    } finally {
      processing.current = false;
    }
  }, [
    aiEnabled,
    cloudRead,
    finishIdentity,
    finishWithFields,
    isCurrent,
    mode,
    readCodes,
  ]);

  useEffect(() => {
    if (!running || mode === "photo" || result || identityMatch) return;
    let cancelled = false;
    let timer = 0;
    const step = async () => {
      if (cancelled) return;
      try {
        await scanTick();
      } catch {
        if (!cancelled)
          setLiveHint(
            "Chưa đọc được. Giữ đúng đối tượng trong khung để thử tiếp.",
          );
      }
      if (!cancelled && !resultRef.current && !identityMatchRef.current)
        timer = window.setTimeout(
          () => void step(),
          mode === "qr"
            ? 300
            : nextTickMs({
                busy: busyRef.current,
                missStreak: misses.current,
                sharp: true,
              }),
        );
    };
    timer = window.setTimeout(() => void step(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [identityMatch, mode, result, running, scanTick]);

  const processImage = async (frame: CapturedFrame, token: number) => {
    if (!isCurrent(token)) return;
    const canvas = await dataUrlToCanvas(frame.dataUrl);
    if (!isCurrent(token)) return;
    if (mode === "photo") {
      if (aiEnabled) await cloudRead(frame, token);
      else
        setMessage("Bật “Dùng AI” để nhận diện loại xe, màu và năm từ ảnh xe.");
      return;
    }
    if (!canvas) {
      setMessage("Không đọc được ảnh. Chọn ảnh khác rõ hơn.");
      return;
    }
    setBusy(true);
    busyRef.current = true;
    let done = false;
    let imageAnalysis: FrameAnalysis | null = null;
    try {
      if (mode === "qr" || mode === "identity")
        done = await readCodes(canvas, token);
      if (!done && isCurrent(token) && mode === "identity") {
        const read = await localReadIdentity(canvas);
        if (read)
          done = await finishIdentity(
            read.document_number,
            token,
            read.uncertainCharacters,
          );
      }
      if (!done && isCurrent(token) && mode === "scan") {
        imageAnalysis = analyzeFrame(canvas);
        const read = await localReadFrame(canvas, {analysis: imageAnalysis});
        if (read)
          done = await finishWithFields(
            { ...read, uncertain_characters: read.warnings },
            "local",
            frame,
            token,
          );
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
    if (done || !isCurrent(token)) return;
    if (mode !== "qr" && aiEnabled) await cloudRead(frame, token);
    else
      setMessage(
        mode === "qr"
          ? "Không tìm thấy QR xe hợp lệ trong ảnh. Chọn ảnh rõ một mã QR."
          : imageAnalysis?.quality.issues.length
            ? imageAnalysis.quality.message
            : "Chưa đọc được thông tin. Chọn ảnh rõ hơn hoặc bật AI để thử tiếp.",
      );
  };

  const shootNow = async () => {
    if (mode !== "photo" || busyRef.current || !videoRef.current) return;
    prepareScanAudio();
    const token = epoch.current;
    photoDraft.current = null;
    busyRef.current = true;
    setBusy(true);
    try {
      const frame = await captureVideoFrame(videoRef.current);
      if (!frame || !isCurrent(token)) return;
      setFrozenPreview(frame.dataUrl);
      await processImage(frame, token);
    } catch (error) {
      if (isCurrent(token)) setMessage(friendlyError(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const pickFromLibrary = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busyRef.current) return;
    prepareScanAudio();
    busyRef.current = true;
    setBusy(true);
    await stopCamera();
    const token = epoch.current;
    try {
      scanSession.current++;
      setMessage("");
      if (resultRef.current || mode === "photo") photoDraft.current = null;
      commitResult(null);
      setPhotoReady(false);
      identityMatchRef.current = null;
      setIdentityMatch(null);
      const frame = await captureFromFile(file);
      if (!isCurrent(token)) return;
      if (!frame) {
        setMessage(
          "Không đọc được tệp ảnh này. Thử ảnh JPG, PNG hoặc WebP khác.",
        );
        return;
      }
      setFrozenPreview(frame.dataUrl);
      await processImage(frame, token);
    } catch (error) {
      if (isCurrent(token)) setMessage(friendlyError(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const chooseMode = async (next: CaptureMode) => {
    if (busy || (next === "identity" && !identityAllowed)) return;
    await stopCamera();
    photoDraft.current = null;
    commitResult(null);
    setPhotoReady(false);
    setFrozenPreview(null);
    setMessage("");
    setLiveHint("");
    identityMatchRef.current = null;
    setIdentityMatch(null);
    const updated = { ...settings, mode: next };
    setSettings(updated);
    saveCameraSettings(updated);
  };

  const continueIdentifiers = () => {
    photoDraft.current = result;
    commitResult(null);
    setPhotoReady(false);
    setFrozenPreview(null);
    setOpenFollowup(true);
    const updated = { ...settings, mode: "scan" as const };
    setSettings(updated);
    saveCameraSettings(updated);
  };

  // Hand every field read so far to the existing intake workflow — the draft
  // travels both in router state and as a sessionStorage fallback.
  const goIntake = (recognition: Recognition) => {
    saveRecognitionDraft(profile?.id, recognition);
    navigate("/intake", { state: { recognition } });
  };

  const toggleTorch = async () => {
    if (changingTorch.current || starting.current || switching.current) return;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torchKind === "none") return;
    const token = epoch.current;
    changingTorch.current = true;
    setTorchBusy(true);
    try {
      await applyTorch(track, torchKind, !torchOn);
      if (isCurrent(token)) setTorchOn(torchStateFromSettings(track));
    } catch {
      if (isCurrent(token))
        setMessage("Camera này chưa bật được đèn. Thử ở nơi đủ sáng hơn.");
    } finally {
      changingTorch.current = false;
      if (mounted.current) setTorchBusy(false);
    }
  };

  const toggleZoom = async () => {
    if (zoomBusy || starting.current || switching.current) return;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !zoomRange) return;
    setZoomBusy(true);
    try {
      const target =
        zoomLevel <= 1.2 ? Math.min(2, zoomRange.max) : zoomRange.min;
      await applyZoom(track, target);
      setZoomLevel(target);
    } catch {
      /* Device may reject zoom */
    } finally {
      if (mounted.current) setZoomBusy(false);
    }
  };

  const handleStageTapToFocus = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!running || frozenPreview) return;
    const stage = event.currentTarget;
    const rect = stage.getBoundingClientRect();
    const clientX = event.clientX - rect.left;
    const clientY = event.clientY - rect.top;
    const normX = Math.max(0, Math.min(1, clientX / rect.width));
    const normY = Math.max(0, Math.min(1, clientY / rect.height));

    setTapFocus({ x: clientX, y: clientY });
    if (tapFocusTimeoutRef.current) {
      window.clearTimeout(tapFocusTimeoutRef.current);
    }
    tapFocusTimeoutRef.current = window.setTimeout(() => {
      if (mounted.current) setTapFocus(null);
    }, 1000);

    const track = streamRef.current?.getVideoTracks()[0];
    if (track) {
      void applyContinuousFocus(track, { x: normX, y: normY }).catch(
        () => undefined,
      );
    }
  };

  const switchCamera = async () => {
    if (
      starting.current ||
      switching.current ||
      changingTorch.current ||
      busyRef.current
    )
      return;
    if (!streamRef.current) {
      setActiveFacing(activeFacing === "environment" ? "user" : "environment");
      return;
    }
    const plan = nextCameraPlan(cameras, activeCameraId, activeFacing);
    if (!plan) return;
    switching.current = true;
    setCameraBusy(true);
    try {
      await stopCamera();
      await startCamera(plan);
    } finally {
      switching.current = false;
      if (mounted.current) setCameraBusy(false);
    }
  };

  if (!operate)
    return (
      <Card>
        <p className="muted">
          Camera thông minh cần quyền vận hành (STAFF trở lên).
        </p>
      </Card>
    );
  const match = result?.match;
  const guide =
    mode === "qr"
      ? "Đưa một mã QR xe vào khung"
      : mode === "identity"
        ? "Đưa mặt có số hoặc QR CCCD vào khung"
        : mode === "photo"
          ? "Lấy toàn cảnh xe rồi chụp ảnh"
          : "Đưa biển số hoặc số khung vào khung";
  const candidates =
    identityMatch?.state === "ambiguous" || identityMatch?.state === "conflict"
      ? identityMatch.candidates
      : match?.state === "ambiguous" || match?.state === "conflict"
        ? match.candidates
        : [];

  return (
    <Card className="smartcam-card">
      <div className="smartcam-card-header">
        <div className="smartcam-title-wrap">
          <h2 className="section-title">
            <Sparkles size={16} aria-hidden="true" />
            <span>Quét và nhận diện</span>
          </h2>
          <span className={"smartcam-status-pill" + (running ? " active" : "")}>
            <span className="smartcam-status-dot" aria-hidden="true" />
            {busy
              ? "Đang đọc"
              : running
                ? mode === "photo"
                  ? "Sẵn sàng chụp"
                  : "Đang quét"
                : "Chờ mở"}
          </span>
        </div>
        <p className="muted small">
          {mode === "photo"
            ? "Chụp hoặc chọn ảnh xe để nhận diện loại xe, màu và năm."
            : "Mở camera là tự quét. Có tiếng tít khi đọc được kết quả."}
        </p>
      </div>
      <div className="smartcam-workspace">
        <div className="smartcam-mode-panel">
          <h3 className="smartcam-panel-title">Chọn chế độ</h3>
          <div
            className="smartcam-mode-toggle"
            role="group"
            aria-label="Chế độ camera"
          >
            {MODES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={
                  "smartcam-mode-btn" + (mode === item.value ? " active" : "")
                }
                aria-pressed={mode === item.value}
                disabled={
                  busy ||
                  cameraBusy ||
                  torchBusy ||
                  (item.value === "identity" && !identityAllowed)
                }
                onClick={() => void chooseMode(item.value)}
              >
                <item.icon size={18} aria-hidden="true" />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.value === "identity" && !identityAllowed
                      ? "Dành cho chủ cửa hàng và quản lý"
                      : item.description}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="smartcam-viewport-column">
          {photoDraft.current && !result && mode === "scan" && (
            <p className="notice">
              Đã giữ thông tin và ảnh xe. Quét thêm biển số hoặc số khung để
              ghép vào cùng kết quả.
            </p>
          )}
          <div className="smartcam-stage" onClick={handleStageTapToFocus}>
            <video
              ref={videoRef}
              className={"smartcam-video" + (running ? "" : " hidden")}
              playsInline
              muted
              aria-label="Hình camera trực tiếp"
            />
            {!running && !frozenPreview && (
              <button
                className="smartcam-standby"
                type="button"
                onClick={() => void startCamera()}
                disabled={busy || cameraBusy || torchBusy}
                aria-label="Bật camera nhận diện"
              >
                <span className="smartcam-standby-reticle" aria-hidden="true">
                  <span className="smartcam-reticle-corner top-left" />
                  <span className="smartcam-reticle-corner top-right" />
                  <span className="smartcam-reticle-corner bottom-left" />
                  <span className="smartcam-reticle-corner bottom-right" />
                  <span className="smartcam-standby-icon-wrap">
                    <Camera size={32} />
                  </span>
                </span>
                <span className="smartcam-standby-title">
                  Chạm để mở camera
                </span>
                <span className="smartcam-standby-sub">{guide}</span>
              </button>
            )}
            {frozenPreview && (
              <img
                className="smartcam-preview"
                src={frozenPreview}
                alt="Ảnh đang nhận diện"
              />
            )}
            {running && tapFocus && (
              <div
                className="smartcam-tap-reticle"
                style={{ left: tapFocus.x, top: tapFocus.y }}
                aria-hidden="true"
              />
            )}
            {running && !frozenPreview && (
              <div
                className={
                  "smartcam-guide" +
                  (mode === "photo" ? " photo" : "") +
                  (mode === "scan" ? " full-preview" : "")
                }
                aria-hidden="true"
              >
                <span className="smartcam-guide-label">{guide}</span>
              </div>
            )}
            {running &&
              !frozenPreview &&
              mode === "scan" &&
              focusRegions.map((region, index) => (
                <div
                  key={index}
                  className="smartcam-focus-region"
                  aria-hidden="true"
                  style={{
                    left: `${region.normalized.x * 100}%`,
                    top: `${region.normalized.y * 100}%`,
                    width: `${region.normalized.width * 100}%`,
                    height: `${region.normalized.height * 100}%`,
                  }}
                >
                  {index === 0 && <span>Vùng chữ</span>}
                </div>
              ))}
            {running && liveHint && (
              <div className="smartcam-hint" role="status">
                {liveHint}
              </div>
            )}
          </div>
          <div className="smartcam-control-panel">
            <div className="smartcam-controls">
              {running && mode === "photo" && (
                <Button
                  type="button"
                  className="smartcam-btn-shutter"
                  disabled={busy || cameraBusy || torchBusy}
                  onClick={() => void shootNow()}
                >
                  <Camera size={16} />
                  <span>{frozenPreview ? "Chụp tấm khác" : "Chụp ảnh xe"}</span>
                </Button>
              )}
              {!running && (
                <div className="smartcam-idle-actions">
                  <Button
                    type="button"
                    variant="primary"
                    className="smartcam-btn-primary"
                    disabled={busy || cameraBusy || torchBusy}
                    onClick={() => void startCamera()}
                  >
                    <Camera size={16} />
                    {cameraBusy ? "Đang mở camera…" : "Mở camera"}
                  </Button>
                  <label
                    className={
                      "button button-secondary smartcam-btn-upload" +
                      (busy || cameraBusy || torchBusy ? " disabled" : "")
                    }
                  >
                    <Images size={16} />
                    <span>Ảnh thư viện</span>
                    <input
                      aria-label={
                        mode === "identity"
                          ? "Chọn ảnh CCCD từ thư viện"
                          : mode === "qr"
                            ? "Chọn ảnh QR xe từ thư viện"
                            : "Chọn ảnh xe từ thư viện"
                      }
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={busy || cameraBusy || torchBusy}
                      onChange={(event) => void pickFromLibrary(event)}
                    />
                  </label>
                </div>
              )}
            </div>
            {running && (
              <div
                className="smartcam-quick-toolbar"
                role="group"
                aria-label="Điều khiển camera nhanh"
              >
                <button
                  type="button"
                  className="smartcam-quick-btn active"
                  disabled={busy || cameraBusy || torchBusy}
                  onClick={() => void stopCamera()}
                  aria-label="Tắt camera"
                  title="Tắt camera"
                >
                  <Power size={20} aria-hidden="true" />
                  <span className="smartcam-quick-label">Tắt cam</span>
                </button>
                <label
                  className={
                    "smartcam-quick-btn smartcam-quick-upload" +
                    (busy || cameraBusy || torchBusy ? " disabled" : "")
                  }
                  aria-label="Tải ảnh lên"
                  title="Tải ảnh lên"
                >
                  <Images size={20} aria-hidden="true" />
                  <span className="smartcam-quick-label">Tải ảnh</span>
                  <input
                    aria-label={
                      mode === "identity"
                        ? "Chọn ảnh CCCD từ thư viện"
                        : mode === "qr"
                          ? "Chọn ảnh QR xe từ thư viện"
                          : "Chọn ảnh xe từ thư viện"
                    }
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy || cameraBusy || torchBusy}
                    onChange={(event) => void pickFromLibrary(event)}
                  />
                </label>
                <button
                  type="button"
                  className={"smartcam-quick-btn" + (torchOn ? " active" : "")}
                  disabled={!torchSupported || cameraBusy || torchBusy}
                  onClick={() => void toggleTorch()}
                  aria-pressed={torchOn}
                  aria-label={torchOn ? "Tắt đèn pin" : "Bật đèn pin"}
                  aria-describedby={
                    !torchSupported ? "smartcam-torch-help" : undefined
                  }
                  title={torchOn ? "Tắt đèn pin" : "Bật đèn pin"}
                >
                  {torchOn ? (
                    <ZapOff size={20} aria-hidden="true" />
                  ) : (
                    <Zap size={20} aria-hidden="true" />
                  )}
                  <span className="smartcam-quick-label">
                    {torchOn ? "Tắt đèn" : "Đèn pin"}
                  </span>
                </button>
                {zoomRange && (
                  <button
                    type="button"
                    className={
                      "smartcam-quick-btn" + (zoomLevel > 1.2 ? " active" : "")
                    }
                    disabled={zoomBusy || cameraBusy}
                    onClick={() => void toggleZoom()}
                    aria-pressed={zoomLevel > 1.2}
                    aria-label={
                      zoomLevel > 1.2 ? "Thu phóng 2x" : "Thu phóng 1x"
                    }
                    title={
                      zoomLevel > 1.2
                        ? "Đang phóng to 2x. Bấm để về 1x"
                        : "Đang ở 1x. Bấm để phóng to 2x"
                    }
                  >
                    <ZoomIn size={20} aria-hidden="true" />
                    <span className="smartcam-quick-label">
                      {zoomLevel > 1.2 ? "2x" : "1x"}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="smartcam-quick-btn"
                  disabled={busy || cameraBusy || torchBusy}
                  onClick={() => void switchCamera()}
                  aria-label={cameraFlipLabel(activeFacing)}
                  title={
                    `Đang dùng ${activeFacing === "user" ? "camera trước" : "camera sau"}`
                  }
                >
                  <SwitchCamera size={20} aria-hidden="true" />
                  <span className="smartcam-quick-label">
                    {cameraFlipLabel(activeFacing)}
                  </span>
                </button>
              </div>
            )}
            {running && !torchSupported && (
              <p
                className="smartcam-device-help muted small"
                id="smartcam-torch-help"
              >
                {cameraBusy
                  ? "Đang mở camera…"
                  : "Camera này không hỗ trợ đèn pin. Có thể đổi sang camera sau."}
              </p>
            )}
          </div>
        </div>
        <div className="smartcam-footer">
          <label className="smartcam-consent">
            <input
              type="checkbox"
              checked={aiEnabled}
              disabled={busy}
              onChange={(event) => {
                epoch.current++;
                const next = {
                  ...settings,
                  cloudMode: event.target.checked
                    ? ("auto" as const)
                    : ("off" as const),
                };
                setSettings(next);
                saveCameraSettings(next);
              }}
            />
            <span>
              Dùng AI để nhận diện ảnh{" "}
              <em>(gửi ảnh đang quét tới dịch vụ AI khi cần)</em>
            </span>
          </label>
          <p className="smartcam-engine">
            <Cpu size={12} aria-hidden="true" />
            <span>
              {OCR_LABELS[engine]}
              {aiEnabled
                ? " · AI: " +
                  cloudUsage.callsLastHour +
                  "/" +
                  cloudUsage.perHour +
                  " lượt trong giờ"
                : ""}
            </span>
          </p>
        </div>
      </div>
      {busy && (
        <p role="status" className="smartcam-busy">
          <span className="smartcam-busy-dot" aria-hidden="true" />
          Đang nhận diện…
        </p>
      )}
      {!busy && message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {identityMatch?.state === "none" && (
        <div className="smartcam-followup">
          <p>
            Không có xe trong kho đang lưu số CCCD này. Nếu là xe của cửa hàng,
            mở hồ sơ xe và nhập đủ 12 số căn cước — chỉ có ảnh thì camera chưa
            tìm được.
          </p>
          <div className="smartcam-actions">
            <Button type="button" variant="secondary" onClick={continueIdentifiers}>
              Quét biển số / số khung để tìm xe
            </Button>
          </div>
        </div>
      )}
      {identityMatch?.state === "ambiguous" && (
        <p role="status" className="notice">
          CCCD này liên quan tới nhiều xe trong kho. Chọn xe cần mở.
        </p>
      )}
      {result && match && (
        <div className={"smartcam-result state-" + match.state}>
          <div className="smartcam-verdict">
            <span className="smartcam-verdict-icon" aria-hidden="true">
              {match.state === "unique" ? (
                <BadgeCheck size={14} />
              ) : (
                <CircleAlert size={14} />
              )}
            </span>
            <span className="smartcam-verdict-text">
              {photoReady ||
              (mode === "photo" &&
                !result.fields.license_plate &&
                !result.fields.frame_number) ? (
                "Đã nhận diện ảnh xe — kiểm tra các thông tin bên dưới."
              ) : match.state === "unique" ? (
                <>
                  {(["license_plate", "frame_number"] as const).every(
                    (key) =>
                      !result.fields[key] ||
                      result.statuses[key] === "VERIFIED",
                  )
                    ? "Đã xác khớp xe trong kho: "
                    : "Xe có thể khớp — kiểm tra chữ đỏ trước khi mở: "}
                  <strong>{vehicleTitle(match.vehicle)}</strong>
                  {vehicleSubtitle(match.vehicle)
                    ? " · " + vehicleSubtitle(match.vehicle)
                    : ""}{" "}
                  ·{" "}
                  {STATUS_LABELS[match.vehicle.status] ?? match.vehicle.status}
                </>
              ) : match.state === "none" ? (
                "Không tìm thấy xe này trong kho. Có thể là xe mới về."
              ) : match.state === "conflict" ? (
                "Biển số và số khung chỉ tới các xe khác nhau — cần kiểm tra lại."
              ) : (
                "Nhiều xe trùng thông tin — chọn đúng xe."
              )}
            </span>
          </div>
          <ResultChips recognition={result} />
          {!!result.photos.length && (
            <div className="smartcam-result-photos">
              {result.photos.map((photo, index) => (
                <button
                  type="button"
                  key={index}
                  aria-label={"Xem lớn ảnh nhận diện " + (index + 1)}
                  onClick={() => setPhotoPreview(photo)}
                >
                  <img src={photo} alt={"Ảnh nhận diện " + (index + 1)} />
                </button>
              ))}
            </div>
          )}
          {photoReady && (
            <div className="smartcam-followup">
              <p>Cần quét thêm biển số và số khung cho xe này không?</p>
              <div className="smartcam-actions">
                <Button type="button" onClick={continueIdentifiers}>
                  Quét biển số / số khung
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setPhotoReady(false);
                    photoDraft.current = null;
                  }}
                >
                  Để sau
                </Button>
              </div>
            </div>
          )}
          {mode === "scan" && match.state === "none" && !photoReady && (
            <div className="smartcam-followup">
              <p>
                {result.fields.frame_number && result.fields.license_plate
                  ? "Bạn muốn thu xe này vào kho?"
                  : "Bạn muốn thu xe này, hay quét tiếp " +
                    (result.fields.frame_number ? "biển số" : "số khung") +
                    "?"}
              </p>
              <div className="smartcam-actions">
                <Button type="button" onClick={() => goIntake(result)}>
                  Thu xe mới
                </Button>
                {(!result.fields.frame_number || !result.fields.license_plate) && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={continueIdentifiers}
                  >
                    Quét tiếp {result.fields.frame_number ? "biển số" : "số khung"}
                  </Button>
                )}
              </div>
            </div>
          )}
          <div className="smartcam-actions">
            {mode === "scan" &&
              match.state !== "none" &&
              (!result.fields.frame_number || !result.fields.license_plate) && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={continueIdentifiers}
                >
                  Quét bổ sung
                </Button>
              )}
            {match.state === "unique" && (
              <Button
                type="button"
                onClick={() => navigate("/vehicles/" + match.vehicle.id)}
              >
                Mở hồ sơ xe
              </Button>
            )}
            {!photoReady &&
              !(mode === "scan" && match.state === "none") && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => goIntake(result)}
                >
                  Thu xe mới (sau khi đã kiểm tra)
                </Button>
              )}
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                photoDraft.current = null;
                void startCamera();
              }}
            >
              <RotateCcw size={14} />
              Quét lại
            </Button>
          </div>
        </div>
      )}
      {!!candidates.length && (
        <div className="smartcam-candidates">
          <span className="smartcam-candidates-label">Chọn xe cần mở</span>
          {candidates.map((row) => (
            <button
              type="button"
              key={row.id}
              className="smartcam-candidate"
              onClick={() => navigate("/vehicles/" + row.id)}
            >
              <strong>{vehicleTitle(row)}</strong>
              <span>{vehicleSubtitle(row) || row.internal_code}</span>
              <small>{STATUS_LABELS[row.status] ?? row.status}</small>
            </button>
          ))}
        </div>
      )}
      {photoPreview &&
        createPortal(
          <div
            className="dialog-backdrop"
            role="presentation"
            onClick={() => setPhotoPreview(null)}
          >
            <div
              className="dialog-panel smartcam-photo-dialog"
              ref={photoDialogRef}
              role="dialog"
              aria-modal="true"
              aria-label="Ảnh nhận diện phóng to"
              onClick={(event) => event.stopPropagation()}
            >
              <img
                src={photoPreview}
                alt="Ảnh gốc để đối chiếu chữ cần kiểm tra"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPhotoPreview(null)}
              >
                Đóng ảnh
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </Card>
  );
}
