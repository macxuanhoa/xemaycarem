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
  X,
  Zap,
  ZapOff,
  ZoomIn,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { canManage, canOperate } from "@/lib/permissions";
import { resolveVehicleQr } from "@/lib/qrcode";
import { canonicalizePlate } from "@/lib/plate";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button, Card } from "@/components/ui";
import {
  classifyFields,
  decisionTier,
  normalizeScan,
  normalizeScanRisks,
  saveRecognitionDraft,
  type DecisionTier,
  type Recognition,
  type ScannedFields,
  type ScannedKey,
  type VehicleMatch,
} from "@/lib/smartcam/recognition";
import {
  applyContinuousFocus,
  applyTorch,
  applyZoom,
  cameraFlipLabel,
  cameraViewportBounds,
  captureFromFile,
  captureVideoFrame,
  currentZoomLevel,
  dataUrlToCanvas,
  frameSharpness,
  loadCameraSettings,
  nextCameraPlan,
  nextVideoFrame,
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
  analyzeFrameOffThread,
  releaseAnalysisWorker,
  type OffThreadResult,
} from "@/lib/smartcam/local/analysisBridge";
import {
  nextTickMs,
  pushEvidence,
  readEvidence,
  type FieldEvidence,
} from "@/lib/smartcam/local/voting";
import {
  inventoryNearMatches,
  type NearMatch,
} from "@/lib/smartcam/inventoryPrior";
import ScanConfirmStrip, {
  type ScanConfirmation,
} from "./ScanConfirmStrip";
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
};
/**
 * A read the camera is not entitled to commit on its own: the recognition is
 * prepared and waiting, the preview stays live, and one tap decides.
 */
type PendingScan = {
  recognition: Recognition;
  confirmation: ScanConfirmation;
};

/** Alphanumerics only — the space vote positions are counted against. */
const compactIdentifier = (value: string) => value.replace(/[^A-Z0-9]/g, "");
/**
 * A tick only contributes evidence when the frame physically deserves trust:
 * the scene must be steady, the analysis confident, and the characters big
 * enough to tell `5` from `S`. Failing the gate costs nothing — such a tick
 * neither votes nor resets — so a shaky hand delays the beep instead of
 * producing a plausible-but-wrong identifier.
 */
const TICK_QUALITY_FLOOR = 0.5;
const TICK_GLYPH_HEIGHT = 18;
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

/**
 * Off-thread frame analysis for one live tick. Null = unsupported/failed,
 * and the caller repeats the same work on the main canvas. Results whose
 * dimensions disagree with the OCR canvas keep the motion signature (pure
 * scene statistics) but drop the region map — crops must stay pixel-exact.
 */
async function remoteAnalyze(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): Promise<OffThreadResult | null> {
  if (typeof createImageBitmap !== "function") return null;
  const bounds = cameraViewportBounds(
    video.videoWidth,
    video.videoHeight,
    video.clientWidth,
    video.clientHeight,
    false,
  );
  try {
    const bitmap = await createImageBitmap(video);
    const result = await analyzeFrameOffThread({
      bitmap,
      crop: bounds ?? null,
      maxEdge: 1600,
    });
    if (!result) return null;
    if (result.width !== canvas.width || result.height !== canvas.height)
      return { ...result, analysis: null };
    return result;
  } catch {
    return null;
  }
}

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
    </div>
  );
}

export type SmartVehicleScanProps = {
  onScanComplete?: (scanned: {
    license_plate: string;
    frame_number: string;
  }) => void;
  onClose?: () => void;
  isModal?: boolean;
};

export default function SmartVehicleScan({
  onScanComplete,
  onClose,
  isModal = false,
}: SmartVehicleScanProps = {}) {
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
  const followUpDraft = useRef<Recognition | null>(null);
  const plateEvidence = useRef<FieldEvidence | null>(null);
  const frameEvidence = useRef<FieldEvidence | null>(null);
  const identityEvidence = useRef<FieldEvidence | null>(null);
  const pendingScan = useRef<PendingScan | null>(null);
  const misses = useRef(0);
  const previousScene = useRef<Float32Array | null>(null);
  // Pixel localization is the heaviest main-thread work in the tick; a stable
  // view reuses its regions briefly instead of re-scanning every frame.
  const analysisCache = useRef<{ at: number; analysis: FrameAnalysis | null }>({
    at: 0,
    analysis: null,
  });
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
  const [confirmation, setConfirmation] = useState<ScanConfirmation | null>(
    null,
  );
  const [result, setResult] = useState<Recognition | null>(null);
  const [identityMatch, setIdentityMatch] = useState<VehicleMatch | null>(null);
  const identityMatchRef = useRef<VehicleMatch | null>(null);
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

  /** Evidence belongs to one look at one bike; a new view starts clean. */
  const resetEvidence = useCallback(() => {
    plateEvidence.current = null;
    frameEvidence.current = null;
    identityEvidence.current = null;
  }, []);

  /**
   * Leave the ask-a-human surface. `rescan` also drops the accumulated
   * evidence so the staff is not re-asked about the same shaky read.
   */
  const clearConfirmation = useCallback(
    (rescan = false) => {
      pendingScan.current = null;
      setConfirmation(null);
      if (rescan) {
        resetEvidence();
        frameWindow.current = [];
        misses.current = 0;
        if (mounted.current)
          setLiveHint("Đưa biển số hoặc số khung rõ hơn vào khung…");
      }
    },
    [resetEvidence],
  );

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
      releaseAnalysisWorker();
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
      if (resultRef.current) followUpDraft.current = null;
      commitResult(null);
      identityMatchRef.current = null;
      setIdentityMatch(null);
      resetEvidence();
      pendingScan.current = null;
      setConfirmation(null);
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
    [activeFacing, commitResult, isCurrent, mode, resetEvidence],
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

  /**
   * Commit a read and take the staff where it points. `locked` means the
   * camera proved it — or a person just decided it — so it may open a record
   * or prefill the acquisition form without another touch.
   */
  const settleResult = useCallback(
    async (recognition: Recognition, locked: boolean): Promise<boolean> => {
      const fields = recognition.fields;
      const match = recognition.match;
      scanTone(
        locked && match.state !== "conflict" && match.state !== "ambiguous"
          ? "match"
          : "review",
      );
      commitResult(recognition);
      saveRecognitionDraft(profile?.id, recognition);
      followUpDraft.current = recognition;
      setLiveHint("");
      await stopCamera();

      // 1. Khi nhúng trong modal form: gọi callback điền vào form ngay lập tức
      if (onScanComplete && (fields.license_plate || fields.frame_number)) {
        onScanComplete({
          license_plate: fields.license_plate || "",
          frame_number: fields.frame_number || "",
        });
        return true;
      }

      const safeIdentity = (["license_plate", "frame_number"] as const).every(
        (key) => !fields[key] || recognition.statuses[key] === "VERIFIED",
      );
      if (
        locked &&
        mode === "scan" &&
        match.state === "unique" &&
        safeIdentity
      ) {
        navigate("/vehicles/" + match.vehicle.id);
        return true;
      }

      // 2. Khi quét ở màn hình camera chính và xe chưa có trong kho:
      // Tự động chuyển thẳng vào form thu xe và điền sẵn thông tin vừa quét.
      // Chỉ chạy khi ký tự đã chắc chắn — một suy đoán không được phép trở
      // thành phiếu thu xe.
      if (
        locked &&
        mode === "scan" &&
        match.state === "none" &&
        (fields.license_plate || fields.frame_number)
      ) {
        const queryParams = new URLSearchParams(window.location.search);
        const returnTo = queryParams.get("returnTo") || "/acquisitions/new";
        toast.success(
          "Đã quét thành công " +
            (fields.license_plate ? `biển số ${fields.license_plate}` : `số khung ${fields.frame_number}`),
          {
            description: "Đã tự động điền thông tin vào form thu xe.",
          },
        );
        navigate(returnTo, {
          state: {
            aiDraft: {
              license_plate: fields.license_plate || "",
              frame_number: fields.frame_number || "",
            },
            recognition,
          },
        });
        return true;
      }
      return true;
    },
    [commitResult, mode, navigate, onScanComplete, profile?.id, stopCamera],
  );

  /** Ask inventory only about the glyph this read admitted it could not read. */
  const askInventory = useCallback(
    async (confirmation: ScanConfirmation, token: number) => {
      const groups = await Promise.all(
        (["license_plate", "frame_number"] as ScannedKey[])
          .filter(
            (key) => confirmation.fields[key] && confirmation.disputed[key].length,
          )
          .map((key) =>
            inventoryNearMatches(key, confirmation.fields[key], confirmation.disputed[key]),
          ),
      );
      const near = groups.flat().slice(0, 2);
      const pending = pendingScan.current;
      if (!near.length || !isCurrent(token) || pending?.confirmation !== confirmation)
        return;
      const next = { ...confirmation, near };
      pendingScan.current = { recognition: pending.recognition, confirmation: next };
      if (mounted.current) setConfirmation(next);
    },
    [isCurrent],
  );

  const finishWithFields = useCallback(
    async (
      draft: Record<string, unknown>,
      via: "local" | "cloud",
      frame: CapturedFrame | null,
      token: number,
      options: {
        /** Per-field proof from the frame evidence; absent = never AUTO. */
        evidence?: { license_plate: boolean; frame_number: boolean };
        /** Runner-up readings, for the ask-a-human surface. */
        alternatives?: Record<ScannedKey, string[]>;
        /** Live loop: an uncertain read pauses instead of closing the camera. */
        interactive?: boolean;
        /** A person already chose these characters on the strip. */
        reviewed?: boolean;
      } = {},
    ) => {
      if (!isCurrent(token)) return false;
      const current = normalizeScan(draft);
      if (!Object.values(current).some(Boolean)) return false;
      const fields =
        followUpDraft.current && mode === "scan"
          ? { ...followUpDraft.current.fields }
          : { ...current };
      for (const key of Object.keys(current) as ScannedKey[])
        if (current[key]) fields[key] = current[key];
      const riskCharacters = { ...followUpDraft.current?.riskCharacters };
      const currentRisks = normalizeScanRisks(draft, current);
      for (const key of ["license_plate", "frame_number"] as const) {
        if (current[key]) {
          delete riskCharacters[key];
          if (currentRisks[key]) riskCharacters[key] = currentRisks[key];
        }
      }
      const match = await lookupScan(fields);
      if (!isCurrent(token)) return false;
      // A cloud read carries no per-frame evidence of its own; it can still be
      // proved by matching one stored vehicle exactly.
      const tier: DecisionTier = options.reviewed
        ? "AUTO"
        : decisionTier(
            fields,
            riskCharacters,
            options.evidence ?? { license_plate: false, frame_number: false },
            match,
          );
      const recognition: Recognition = {
        version: 1,
        scannedAt: new Date().toISOString(),
        fields,
        statuses: classifyFields(fields, match, riskCharacters),
        match,
        photos: [
          ...(followUpDraft.current?.photos ?? []),
          ...(frame ? [frame.dataUrl] : []),
        ].slice(0, 4),
        source: via,
        riskCharacters,
        tier,
        ...(options.alternatives ? { alternatives: options.alternatives } : {}),
      };
      if (tier === "CONFIRM" && options.interactive) {
        // A read the camera cannot prove is a question, not a result: the
        // preview stays live, the low tone says "look at this one", and only
        // the character in doubt is put in front of the staff.
        const confirmation: ScanConfirmation = {
          fields,
          disputed: {
            license_plate: riskCharacters.license_plate ?? [],
            frame_number: riskCharacters.frame_number ?? [],
          },
          alternatives: options.alternatives ?? {
            license_plate: [],
            frame_number: [],
          },
          near: [],
        };
        pendingScan.current = { recognition, confirmation };
        scanTone("review");
        if (mounted.current) {
          setConfirmation(confirmation);
          setLiveHint("Camera chưa chắc chắn — giữ yên để đọc lại, hoặc xác nhận ký tự được đánh dấu.");
        }
        void askInventory(confirmation, token);
        return false;
      }
      return settleResult(recognition, tier === "AUTO");
    },
    [askInventory, isCurrent, mode, settleResult],
  );

  /** The staff confirmed the read: it is now an authoritative value. */
  const acceptConfirmation = useCallback(() => {
    const pending = pendingScan.current;
    clearConfirmation();
    if (!pending) return;
    void settleResult({ ...pending.recognition, tier: "AUTO" }, true);
  }, [clearConfirmation, settleResult]);

  /**
   * The staff said "this is the bike in stock". The record's own characters
   * become the value, so the exact-match lookup legitimately returns VERIFIED —
   * a person chose it, the camera never substituted it.
   */
  const acceptInventoryMatch = useCallback(
    async (match: NearMatch) => {
      const pending = pendingScan.current;
      if (!pending) return;
      const fields: ScannedFields = {
        ...pending.confirmation.fields,
        [match.field]:
          match.field === "license_plate"
            ? canonicalizePlate(match.vehicle.license_plate)
            : match.vehicle.frame_number,
      };
      clearConfirmation();
      try {
        const resolved = await lookupScan(fields);
        await settleResult(
          {
            ...pending.recognition,
            fields,
            statuses: classifyFields(fields, resolved, {}),
            match: resolved,
            riskCharacters: {},
            tier: "AUTO",
          },
          true,
        );
      } catch (error) {
        if (mounted.current) setMessage(friendlyError(error));
      }
    },
    [clearConfirmation, settleResult],
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
            mode === "identity" ? ("identity" as const) : ("identifiers" as const),
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
      // Waiting on a human answer: the preview stays live, but the loop must
      // not spend another OCR pass on a read it has already put up for review.
      pendingScan.current ||
      identityMatchRef.current
    )
      return;
    const video = videoRef.current;
    if (!video) return;
    // Only read pixels from a freshly decoded frame — the same stale or
    // half-moved frame must not burn an OCR pass or poison the vote.
    await nextVideoFrame(video);
    if (!streamRef.current) return;
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
      const remote = mode === "scan" ? await remoteAnalyze(video, canvas) : null;
      if (!isCurrent(token)) return;
      let analysis: FrameAnalysis | null = remote?.analysis ?? null;
      // Greyscale on the main thread only when the worker gave no signature.
      const gray = remote?.signature ? null : toGray(canvas);
      const sig = remote?.signature ?? (gray ? sceneSignature(gray) : null);
      let motionStable = false;
      if (sig) {
        const motion = motionScore(previousScene.current, sig);
        motionStable = motion < 0.1;
        if (motion > 0.60) {
          resetEvidence();
          frameWindow.current = [];
          misses.current = 0;
          analysisCache.current = { at: 0, analysis: null };
        }
        previousScene.current = sig;
      }
      if (mode === "scan" && !analysis) {
        const cached = analysisCache.current;
        analysis =
          motionStable &&
          Date.now() - cached.at < 700 &&
          cached.analysis &&
          cached.analysis.width === canvas.width &&
          cached.analysis.height === canvas.height
            ? cached.analysis
            : null;
        if (!analysis) {
          analysis = analyzeFrame(canvas, gray);
          analysisCache.current = { at: Date.now(), analysis };
        }
      }
      if (mode === "scan") {
        setFocusRegions(analysis?.regions.slice(0, 2) ?? []);
        setLiveHint(analysis?.quality.message ?? "Đang tìm vùng chữ để đọc…");
      }
      if (mode !== "scan" && frameSharpness(canvas) < 0.35) {
        if (isCurrent(token))
          setLiveHint("Giữ yên, đưa gần hơn và tăng ánh sáng để đọc rõ.");
        return;
      }
      if (mode === "identity") {
        const read = await localReadIdentity(canvas);
        if (!isCurrent(token)) return;
        identityEvidence.current = pushEvidence(
          identityEvidence.current,
          read?.document_number
            ? {
                value: read.document_number,
                compact: read.document_number,
                confidence: read.confidence,
                disputed: read.uncertainCharacters,
                // A CCCD whose digit had to be guessed is never automatic.
                autoEligible: read.uncertainCharacters.length === 0,
              }
            : null,
        );
        const outcome = readEvidence(identityEvidence.current);
        if (
          outcome.settled &&
          !outcome.disputed.length &&
          (await finishIdentity(outcome.value, token, outcome.disputed))
        )
          return;
        if (read) setLiveHint("Đang kiểm tra số CCCD — giữ yên căn cước…");
        // Only unreadable ticks starve the sampler; a mid-vote CCCD keeps the
        // fast cadence and must not trigger the cloud fallback.
        if (read?.document_number) misses.current = 0;
        else misses.current++;
      } else {
        const read = await localReadFrame(canvas, {
          analysis: analysis ?? undefined,
          fast: true,
        });
        if (!isCurrent(token)) return;
        const hasIdentifier = !!(read?.license_plate || read?.frame_number);
        frameWindow.current = appendScanSample(frameWindow.current, {
          // Keyed by how many characters were read, not by the exact string: a
          // single disagreeing glyph is evidence, not a different object.
          slots: read
            ? compactIdentifier(read.license_plate).length +
              compactIdentifier(read.frame_number).length
            : 0,
          analysis,
          value: { canvas, read },
        });
        // A tick only votes when the frame physically deserves trust: steady,
        // confidently analysed, characters big enough to tell 5 from S, and not
        // two conflicting identifiers. Failing the gate neither adds nor
        // discards evidence, so the cadence is untouched — a shaky hand delays
        // the beep instead of producing a plausible-but-wrong identifier.
        const tallest = Math.max(
          0,
          ...(analysis?.regions.map((region) => region.characterHeight) ?? []),
        );
        const trustworthy =
          !!read &&
          hasIdentifier &&
          motionStable &&
          (analysis?.quality.score ?? 0) >= TICK_QUALITY_FLOOR &&
          !read.ambiguous.length &&
          (!analysis?.regions.length || tallest >= TICK_GLYPH_HEIGHT);
        if (trustworthy && read) {
          plateEvidence.current = pushEvidence(
            plateEvidence.current,
            read.license_plate
              ? {
                  value: read.license_plate,
                  compact: compactIdentifier(read.license_plate),
                  confidence: read.plateConfidence,
                  disputed: read.warnings.license_plate,
                  autoEligible: read.autoEligible.license_plate,
                }
              : null,
          );
          frameEvidence.current = pushEvidence(
            frameEvidence.current,
            read.frame_number
              ? {
                  value: read.frame_number,
                  compact: compactIdentifier(read.frame_number),
                  confidence: read.frameConfidence,
                  disputed: read.warnings.frame_number,
                  autoEligible: read.autoEligible.frame_number,
                }
              : null,
          );
        }
        if (hasIdentifier)
          setLiveHint(
            "Đang đọc " +
              (read?.license_plate || read?.frame_number) +
              " — giữ yên…",
          );
        const plate = readEvidence(plateEvidence.current);
        const chassis = readEvidence(frameEvidence.current);
        // Fire only once every field this burst has seen has settled, so a
        // confident biển số cannot cut off a số khung still being resolved.
        const settled =
          (plate.settled || chassis.settled) &&
          (!plateEvidence.current || plate.settled) &&
          (!frameEvidence.current || chassis.settled);
        if (settled && read) {
          const best = bestScanSample(frameWindow.current)?.value;
          const chosen = best?.read ?? read;
          const fields: Record<ScannedKey, string> = {
            // The winning reading of the vote, not whichever frame happened to
            // be sharpest: agreement across frames is the evidence.
            license_plate: plate.value,
            frame_number: chassis.value,
          };
          // A clearer image must not erase warnings observed on another
          // agreeing frame.
          const disputed = {
            license_plate: [...new Set([...plate.disputed, ...chosen.warnings.license_plate])].sort(
              (a, b) => a - b,
            ),
            frame_number: [...new Set([...chassis.disputed, ...chosen.warnings.frame_number])].sort(
              (a, b) => a - b,
            ),
          };
          const still = await captureVideoFrame(best?.canvas ?? canvas);
          if (
            await finishWithFields(
              { ...fields, uncertain_characters: disputed },
              "local",
              still,
              token,
              {
                evidence: {
                  license_plate: plate.autoEligible,
                  frame_number: chassis.autoEligible,
                },
                alternatives: {
                  license_plate: [
                    ...new Set([
                      ...chosen.alternatives.license_plate,
                      ...plate.alternatives,
                    ]),
                  ],
                  frame_number: [
                    ...new Set([
                      ...chosen.alternatives.frame_number,
                      ...chassis.alternatives,
                    ]),
                  ],
                },
                interactive: true,
              },
            )
          )
            return;
        }
        // Ticks that read a candidate (waiting on the vote) are productive:
        // keep the base cadence and don't count them toward the cloud fallback.
        if (hasIdentifier) misses.current = 0;
        else misses.current++;
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
    resetEvidence,
  ]);

  useEffect(() => {
    if (!running || result || identityMatch) return;
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
            {
              // One still image carries no per-frame vote, but its own region
              // and full-frame passes must still agree before anything locks.
              evidence: read.autoEligible,
              alternatives: read.alternatives,
            },
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
      if (resultRef.current) followUpDraft.current = null;
      commitResult(null);
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
    followUpDraft.current = null;
    commitResult(null);
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
    followUpDraft.current = result;
    commitResult(null);
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
        : "Đưa biển số hoặc số khung vào khung";
  const candidates =
    identityMatch?.state === "ambiguous" || identityMatch?.state === "conflict"
      ? identityMatch.candidates
      : match?.state === "ambiguous" || match?.state === "conflict"
        ? match.candidates
        : [];

  return (
    <Card className={"smartcam-card" + (isModal ? " is-modal" : "")}>
      <div className="smartcam-card-header">
        <div className="smartcam-title-wrap">
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <h2 className="section-title">
              <Sparkles size={16} aria-hidden="true" />
              <span>Quét và nhận diện</span>
            </h2>
            <span className={"smartcam-status-pill" + (running ? " active" : "")}>
              <span className="smartcam-status-dot" aria-hidden="true" />
              {busy
                ? "Đang đọc"
                : running
                  ? "Đang quét"
                  : "Chờ mở"}
            </span>
          </div>
          {onClose && (
            <button
              type="button"
              className="dialog-close"
              aria-label="Đóng camera"
              onClick={onClose}
              style={{ margin: 0, padding: "6px" }}
            >
              <X size={18} />
            </button>
          )}
        </div>
        <p className="muted small">
          Mở camera là tự quét. Có tiếng tít khi đọc được kết quả.
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
          {followUpDraft.current && !result && mode === "scan" && (
            <p className="notice">
              Đã giữ thông tin đã quét. Quét thêm biển số hoặc số khung để
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
            {confirmation && (
              <ScanConfirmStrip
                confirmation={confirmation}
                onAccept={acceptConfirmation}
                onRescan={() => clearConfirmation(true)}
                onUseInventory={(match) => void acceptInventoryMatch(match)}
              />
            )}
            <div className="smartcam-controls">
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
              {match.state === "unique" ? (
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
          {mode === "scan" && match.state === "none" && (
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
            {!(mode === "scan" && match.state === "none") && (
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
                followUpDraft.current = null;
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
