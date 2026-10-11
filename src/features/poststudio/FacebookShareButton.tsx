// Nút "Chuyển vào Facebook" + lời báo trung thực về những gì đã xảy ra.
//
// Ba điều phân biệt rõ ràng, không gộp:
//  1) đã TRAO nội dung cho tiện ích / share sheet  → button hết việc
//  2) đã XÁC MINH composer nhận đủ chữ + ảnh       → only EXTENSION nói được
//  3) bài ĐÃ LÊN Facebook                          → CRM không biết, không được nói
//
// Vì vậy nhãn nút là "Chuyển vào Facebook", không phải "Đăng bài".

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/lib/toast";
import type { PostChannel } from "@/lib/postStudioApi";
import { describePlan, shareVehiclePost } from "@/lib/fbShare/service";
import type { ShareResult } from "@/lib/fbShare/service";
import { strategyLabels } from "@/lib/fbShare/detect";
import type { StrategyChoice } from "@/lib/fbShare/detect";
import { downloadShareImage, prepareShareImages, primeShareImages } from "@/lib/fbShare/images";
import { emptyOutcome, stageLabels } from "@/lib/fbShare/status";
import type { ShareOutcome, ShareStage } from "@/lib/fbShare/status";

const ZIP_HREF = "/carem-fb-extension.zip";

export type SharePlan = {
  choice: StrategyChoice;
  extensionReady: boolean;
  platform: string;
};

/** Biết trước sẽ dùng cách nào (và vì sao) ngay khi trang hiện ra. */
export function useSharePlan() {
  const [plan, setPlan] = useState<SharePlan | null>(null);
  const refresh = useCallback(async () => {
    try {
      const { choice, env } = await describePlan();
      setPlan({ choice, extensionReady: env.extensionReady, platform: env.platform });
    } catch {
      setPlan(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { plan, refresh };
}

function statusTone(stage: ShareStage): "" | "is-ok" | "is-warn" | "is-error" {
  if (stage === "READY_FOR_REVIEW") return "is-ok";
  if (stage === "PARTIAL_SUCCESS" || stage === "FALLBACK_REQUIRED" || stage === "CANCELLED") return "is-warn";
  if (stage === "FAILED") return "is-error";
  return "";
}

export type FacebookShareButtonProps = {
  caption: string;
  imagePaths?: string[];
  vehicleLabel?: string;
  channel: PostChannel;
  groupUrl?: string;
  disabled?: boolean;
  /** "primary" cho bản đang làm việc, "secondary" cho từng thẻ nháp. */
  variant?: "primary" | "secondary";
  label?: string;
};

export function FacebookShareButton({
  caption,
  imagePaths = [],
  vehicleLabel,
  channel,
  groupUrl,
  disabled,
  variant = "primary",
  label,
}: FacebookShareButtonProps) {
  const [stage, setStage] = useState<ShareStage>("IDLE");
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const [result, setResult] = useState<ShareResult | null>(null);
  const busy = stage === "PREPARING" || stage === "OPENING" || stage === "TRANSFERRING" || stage === "VERIFYING";
  const alive = useRef(true);

  // Ảnh vào bộ nhớ ngay khi thẻ hiện ra: lúc bấm là đi được liền, không chờ tải
  // (Web Share trên điện thoại chỉ chạy khi còn "user activation" của cú bấm).
  useEffect(() => {
    alive.current = true;
    if (imagePaths.length) void primeShareImages(imagePaths);
    return () => {
      alive.current = false;
    };
  }, [imagePaths]);

  const run = async () => {
    setOutcome(null);
    setResult(null);
    try {
      const shareResult = await shareVehiclePost(
        {
          caption,
          imagePaths,
          vehicleLabel,
          target: channel === "FB_GROUP" ? "GROUP" : "PERSONAL",
          groupUrl,
        },
        (next) => {
          if (alive.current) setStage(next);
        },
      );
      if (!alive.current) return;
      setResult(shareResult);
      setOutcome(shareResult.outcome);
      setStage(shareResult.outcome.stage);
      if (shareResult.outcome.stage === "READY_FOR_REVIEW") toast.success(shareResult.outcome.detail);
      else if (shareResult.outcome.stage === "CANCELLED") toast.info(shareResult.outcome.detail);
      else toast.error(shareResult.outcome.detail);
    } catch (error) {
      if (!alive.current) return;
      const detail = error instanceof Error ? error.message : "Chưa chuyển được nội dung.";
      setOutcome({ ...emptyOutcome("MANUAL"), stage: "FAILED", detail });
      setStage("FAILED");
      toast.error(detail);
    }
  };

  const skipped = result?.skipped ?? [];
  const tried = result?.tried ?? [];

  return (
    <div className="ps-share-wrap">
      <Button
        variant={variant}
        onClick={() => void run()}
        disabled={disabled || busy || !caption.trim()}
        aria-busy={busy}
      >
        {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <ExternalLink size={15} aria-hidden="true" />}
        {busy ? stageLabels[stage] : (label ?? "Chuyển vào Facebook")}
      </Button>

      {outcome && outcome.stage !== "IDLE" && (
        <p className={`ps-share-status ${statusTone(outcome.stage)}`.trim()} role="status">
          <strong>{stageLabels[outcome.stage]}</strong>
          {outcome.detail}
          {outcome.strategy === "EXTENSION" && outcome.captionFilled && (
            <span className="ps-share-how">
              {"Cầu đăng Facebook đã đọc lại ô soạn thảo và thấy đủ nội dung. Chưa ai bấm Đăng thay bạn."}
            </span>
          )}
          {tried.length > 1 && (
            <span className="ps-share-how">
              {"Đã lần lượt thử: "}
              {tried.map((id) => strategyLabels[id]).join(" → ")}
            </span>
          )}
        </p>
      )}

      {skipped.length > 0 && (
        <p className="ps-share-status is-warn" role="status">
          <strong>{`Bị loại ${skipped.length} ảnh`}</strong>
          {skipped.map((item) => `${item.reason}`).join(" · ")}
        </p>
      )}

      {result && result.outcome.imagesExpected > result.outcome.imagesAttached && (
        <button
          type="button"
          className="ps-linkbtn"
          onClick={async () => {
            const prepared = await prepareShareImages(imagePaths, vehicleLabel);
            for (const image of prepared.images) downloadShareImage(image);
            toast.success(`Đã tải ${prepared.images.length} ảnh về máy — đính kèm tay trong Facebook nhé.`);
          }}
        >
          <Download size={13} aria-hidden="true" /> Tải ảnh về để đính kèm tay
        </button>
      )}
    </div>
  );
}

/**
 * Hướng dẫn cài Cầu đăng — chỉ hiện trên desktop khi chưa bắt được tiện ích.
 * Nói thẳng giới hạn trình duyệt thay vì để người dùng đoán vì sao phải dán tay.
 */
export function FacebookShareSetup({ platform }: { platform: string }) {
  if (platform !== "desktop") return null;
  return (
    <div className="ps-ext-hint">
      <strong>Muốn tự điền thẳng vào Facebook? Cài “Cầu đăng Facebook” (làm một lần)</strong>
      <p className="ps-hint">
        Trình duyệt không cho trang web khác chạm vào ô đăng bài của Facebook — đó là luật
        an toàn, không phải chưa viết được. Tiện ích này nằm ngay trên máy bạn nên làm được,
        và nó chỉ điền + kiểm tra, KHÔNG bấm Đăng.
      </p>
      <ol>
        <li>
          Tải <a href={ZIP_HREF} download><code>carem-fb-extension.zip</code></a> rồi giải nén.
        </li>
        <li>
          Mở <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>) → bật
          <em> Developer mode</em>.
        </li>
        <li>
          Bấm <strong>Load unpacked</strong> → chọn thư mục <code>carem-fb-share</code>.
        </li>
        <li>Quay lại đây, bấm lại nút chuyển bài. Tiện ích chỉ điền, bạn mới là người Đăng.</li>
      </ol>
    </div>
  );
}
