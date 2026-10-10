// Module A — AI Post Studio: chọn xe từ Kho, tạo 2–3 caption phong cách Cà Rem
// qua trợ lý AI (Edge Function post-ai), chat chỉnh sửa nhiều lượt, lưu nháp /
// phiên bản / duyệt, chọn & tải ảnh đăng thủ công. KHÔNG tự đăng Facebook.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  History,
  ImageIcon,
  Send,
  Sparkles,
} from "lucide-react";
import "@/styles-poststudio.css";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
} from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import {
  postStudio,
  type AssistCaptionReply,
  type AssistRefineReply,
  type PostChannel,
  type PostDraft,
  type PostKind,
  type StudioContext,
  type Tone,
} from "@/lib/postStudioApi";
import { buildTemplateCaptions } from "./captionTemplates";
import type { Paged, Vehicle } from "@/types";

const kindOptions: { value: PostKind; label: string }[] = [
  { value: "NEW_STOCK", label: "Xe mới về" },
  { value: "PROMO", label: "Ưu đãi" },
  { value: "SOLD", label: "Xe vừa bán" },
  { value: "MULTI", label: "Nhiều xe" },
  { value: "BUYBACK", label: "Tìm thu mua" },
];
const channelOptions: { value: PostChannel; label: string }[] = [
  { value: "FACEBOOK", label: "Facebook cá nhân" },
  { value: "FB_GROUP", label: "Hội nhóm FB" },
  { value: "ZALO", label: "Zalo" },
];
const toneOptions: { value: Tone; label: string }[] = [
  { value: "THAN_THIEN", label: "Thân thiện" },
  { value: "NGAN_GON", label: "Ngắn gọn" },
  { value: "CHUYEN_NGHIA", label: "Chuyên nghiệp" },
  { value: "VUI_VANG", label: "Vui vẻ" },
];
const draftStatusLabels: Record<string, string> = {
  DRAFT: "Nháp",
  APPROVED: "Đã duyệt",
  ARCHIVED: "Lưu trữ",
};

function VehiclePicker({
  vehicle,
  onPick,
}: {
  vehicle: Vehicle | null;
  onPick: (vehicle: Vehicle | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [stockTab, setStockTab] = useState<"IN_STOCK" | "SOLD">("IN_STOCK");
  const deferredSearch = useDebouncedValue(search, 250);
  const query = useQuery({
    queryKey: ["post-studio-vehicles", deferredSearch, stockTab],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: {
          search: deferredSearch,
          status: stockTab,
          sort: "newest",
          limit: 12,
          offset: 0,
        },
      }),
  });
  const items = query.data?.items ?? [];
  return (
    <div className="ps-picker">
      <div className="ps-picker-controls">
        <div className="ps-tabs" role="tablist" aria-label="Trạng thái xe">
          <button
            type="button"
            role="tab"
            aria-selected={stockTab === "IN_STOCK"}
            className={stockTab === "IN_STOCK" ? "is-active" : ""}
            onClick={() => setStockTab("IN_STOCK")}
          >
            Đang bày bán
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={stockTab === "SOLD"}
            className={stockTab === "SOLD" ? "is-active" : ""}
            onClick={() => setStockTab("SOLD")}
          >
            Đã bán
          </button>
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Tìm biển số, loại xe, màu…"
          aria-label="Tìm xe trong kho"
        />
      </div>
      {query.isPending && <Loading />}
      {query.isError && <ErrorState error={query.error} />}
      {!query.isPending && !query.isError && !items.length && (
        <EmptyState title="Chưa có xe" description="Đổi từ khóa hoặc tab trạng thái nhé." />
      )}
      <ul className="ps-vehicle-list">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`ps-vehicle-card${vehicle?.id === item.id ? " is-selected" : ""}`}
              onClick={() => onPick(vehicle?.id === item.id ? null : item)}
              aria-pressed={vehicle?.id === item.id}
            >
              <span className="ps-vehicle-title">{item.vehicle_title ?? item.license_plate}</span>
              <span className="ps-vehicle-sub">
                {[item.vehicle_type, item.year, item.color].filter(Boolean).join(" · ")}
              </span>
              {vehicle?.id === item.id && <Check size={16} aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ul>
      {vehicle && (
        <p className="ps-picked-note">
          Đang dùng: <strong>{vehicle.vehicle_title ?? vehicle.license_plate}</strong>{" "}
          <button type="button" className="ps-linkbtn" onClick={() => onPick(null)}>
            bỏ chọn
          </button>
        </p>
      )}
    </div>
  );
}

export default function PostStudioPage() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const isOwner = profile?.role === "OWNER";

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [kind, setKind] = useState<PostKind>("NEW_STOCK");
  const [channel, setChannel] = useState<PostChannel>("FACEBOOK");
  const [tone, setTone] = useState<Tone>("THAN_THIEN");

  const [context, setContext] = useState<StudioContext | null>(null);
  const [captions, setCaptions] = useState<string[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [sourceNote, setSourceNote] = useState<string | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [instruction, setInstruction] = useState("");
  const [pickedImages, setPickedImages] = useState<Record<string, boolean>>({});
  const [showVersions, setShowVersions] = useState(false);
  const [addApprovedToLibrary, setAddApprovedToLibrary] = useState(true);

  const generate = useMutation({
    mutationFn: async () => {
      if (kind !== "BUYBACK" && !vehicle)
        throw new Error("Hãy chọn chiếc xe từ Kho trước khi tạo bài.");
      const variation = captions.length ? 1 : 0;
      try {
        const result = await postStudio.assist<AssistCaptionReply>({
          task: "captions",
          consent: true,
          post_kind: kind,
          channel,
          tone,
          ...(vehicle ? { vehicle_id: vehicle.id } : {}),
        });
        setContext(result.vehicle);
        setAiUsed(true);
        setSourceNote(`AI: ${result.model} — kiểm tra lại trước khi đăng.`);
        return result.captions;
      } catch (error) {
        // AI ngoài tầm với (quota, tắt, lỗi) → mẫu template tại chỗ, nghiệp vụ không đứt.
        const fallbackContext = vehicle ? await postStudio.context(vehicle.id) : null;
        setContext(fallbackContext);
        setAiUsed(false);
        setSourceNote(
          `Dùng mẫu có sẵn (AI chưa khả dụng: ${error instanceof Error ? error.message : "lỗi"}) — vẫn an toàn, không giá, không bịa.`,
        );
        return buildTemplateCaptions(fallbackContext, kind, channel, tone, variation);
      }
    },
    onSuccess: (result) => {
      setCaptions(result);
      setTurns([]);
      setDraftId(null);
      setPickedImages({});
      toast.success("Đã có caption. Đọc lại hộ Cà Rem trước khi đăng nhé!");
    },
  });

  const refine = useMutation({
    mutationFn: async (index: number) => {
      const caption = captions[index]?.trim();
      const ask = instruction.trim();
      if (!caption || ask.length < 2) throw new Error("Nhập câu muốn sửa trước đã.");
      const boundedTurns = turns
        .slice(-4)
        .map((turn) => ({ role: turn.role, text: turn.text.slice(0, 1000) }));
      const result = await postStudio.assist<AssistRefineReply>({
        task: "refine",
        consent: true,
        channel,
        caption,
        instruction: ask.slice(0, 600),
        ...(boundedTurns.length ? { turns: boundedTurns } : {}),
      });
      return { index, ask, caption: result.caption };
    },
    onSuccess: ({ index, ask, caption }) => {
      setCaptions((current) => current.map((item, i) => (i === index ? caption : item)));
      setTurns((current) => [...current, { role: "user" as const, text: ask }, { role: "assistant" as const, text: caption }].slice(-6));
      setInstruction("");
      setDraftId(null); // caption mới là bản chưa lưu
    },
    onError: (error) => toast.error(error.message),
  });

  const saveDraft = useMutation({
    mutationFn: (caption: string) =>
      postStudio.saveDraft({
        ...(draftId ? { id: draftId } : {}),
        vehicle_id: vehicle?.id ?? null,
        post_kind: kind,
        channel,
        tone,
        caption,
        ai_generated: aiUsed,
      }),
    onSuccess: (id) => {
      setDraftId(id);
      toast.success("Đã lưu nháp vào kho bài đăng.");
      client.invalidateQueries({ queryKey: ["post-drafts"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const drafts = useQuery({
    queryKey: ["post-drafts"],
    queryFn: () => postStudio.listDrafts({ limit: 10 }),
  });
  const versions = useQuery({
    queryKey: ["post-draft-versions", draftId],
    queryFn: () => postStudio.draftVersions(draftId as string),
    enabled: showVersions && !!draftId,
  });

  const setStatus = useMutation({
    mutationFn: (args: { id: string; status: "APPROVED" | "ARCHIVED" }) =>
      postStudio.setDraftStatus(args.id, args.status, args.status === "APPROVED" && addApprovedToLibrary),
    onSuccess: (_data, args) => {
      toast.success(args.status === "APPROVED" ? "Chủ quán đã duyệt bài." : "Đã chuyển nháp vào lưu trữ.");
      client.invalidateQueries({ queryKey: ["post-drafts"] });
      client.invalidateQueries({ queryKey: ["brand-memory"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const imageUrls = useMemo(
    () => (context?.images ?? []).map((image) => image.storage_path),
    [context],
  );
  const downloadImages = useMutation({
    mutationFn: async () => {
      const paths = imageUrls.filter((path) => pickedImages[path]);
      if (!paths.length) throw new Error("Chưa chọn ảnh nào để tải.");
      for (const [index, path] of paths.entries()) {
        const url = await postStudio.imageUrl(path);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${(context?.license_plate ?? "xe-carem").replace(/[^\w.-]+/g, "-")}-${index + 1}.jpg`;
        link.click();
        // Chờ trình duyệt kịp nhận tệp trước khi ký URL tiếp theo (Signed URL ngắn hạn).
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return paths.length;
    },
    onSuccess: (count) => toast.success(`Đã tải ${count} ảnh — đăng thủ công nhé.`),
    onError: (error) => toast.error(error.message),
  });

  const copyCaption = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Đã sao chép caption — dán lên Facebook/Zalo thủ công.");
    } catch {
      toast.error("Trình duyệt chặn clipboard. Hãy bôi đen và copy thủ công.");
    }
  };

  return (
    <div className="ps-page">
      <PageHeader
        title="Studio bài đăng AI"
        description="Chọn xe trong Kho → 2–3 caption phong cách Cà Rem, chat để sửa đến vừa ý. Bài chỉ ra tay sau khi bạn kiểm tra — hệ thống không tự đăng."
        actions={
          <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
            <Sparkles size={16} aria-hidden="true" />
            {generate.isPending ? "Đang viết…" : captions.length ? "Tạo lại" : "Tạo caption"}
          </Button>
        }
      />

      <Card className="ps-step">
        <h2>1 · Chọn xe từ Kho</h2>
        <VehiclePicker
          vehicle={vehicle}
          onPick={(next) => {
            setVehicle(next);
            setCaptions([]);
            setContext(null);
            setDraftId(null);
          }}
        />
        {kind === "BUYBACK" && (
          <p className="ps-hint">Bài tìm thu mua không gắn một xe cụ thể — có thể bỏ qua bước chọn xe.</p>
        )}
      </Card>

      <Card className="ps-step">
        <h2>2 · Kiểu bài & kênh đăng</h2>
        <div className="ps-chiprow" role="group" aria-label="Loại bài đăng">
          {kindOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`ps-chip${kind === option.value ? " is-active" : ""}`}
              aria-pressed={kind === option.value}
              onClick={() => setKind(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="ps-chiprow" role="group" aria-label="Kênh đăng">
          {channelOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`ps-chip${channel === option.value ? " is-active" : ""}`}
              aria-pressed={channel === option.value}
              onClick={() => setChannel(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Field label="Giọng điệu">
          <select value={tone} onChange={(event) => setTone(event.target.value as Tone)}>
            {toneOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="ps-hint">
          Trợ lý chỉ nhận thông tin công khai an toàn của xe (loại, đời, màu, biển số). Giá thu,
          lợi nhuận, giấy tờ khách và số cá nhân không bao giờ rời khỏi CRM.
        </p>
        {generate.isError && <ErrorState error={generate.error} />}
      </Card>

      {captions.length > 0 && (
        <Card className="ps-step">
          <h2>3 · Caption ứng viên</h2>
          {sourceNote && <p className="ps-source">{sourceNote}</p>}
          {captions.map((caption, index) => (
            <div className="ps-caption-card" key={`${caption.slice(0, 24)}-${index}`}>
              <textarea
                rows={5}
                value={caption}
                aria-label={`Caption ${index + 1}`}
                onChange={(event) =>
                  setCaptions((current) =>
                    current.map((item, i) => (i === index ? event.target.value : item)),
                  )
                }
              />
              <div className="ps-caption-actions">
                <Button variant="secondary" onClick={() => copyCaption(caption)}>
                  <Copy size={15} aria-hidden="true" /> Sao chép
                </Button>
                <Button variant="secondary" onClick={() => saveDraft.mutate(caption)} disabled={saveDraft.isPending}>
                  {saveDraft.isPending && saveDraft.variables === caption ? "Đang lưu…" : draftId ? "Lưu lại" : "Lưu nháp"}
                </Button>
              </div>
            </div>
          ))}

          <div className="ps-chat">
            <h3>Chat sửa bài</h3>
            {turns.length > 0 && (
              <ul className="ps-chat-log">
                {turns.map((turn, index) => (
                  <li key={index} className={`ps-turn is-${turn.role}`}>
                    {turn.text}
                  </li>
                ))}
              </ul>
            )}
            <div className="ps-chat-input">
              <input
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="VD: ngắn lại, thêm mời ghé quán cuối tuần…"
                aria-label="Yêu cầu sửa caption"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !refine.isPending) refine.mutate(0);
                }}
              />
              <Button onClick={() => refine.mutate(0)} disabled={refine.isPending || !aiUsed}>
                <Send size={15} aria-hidden="true" />
                {refine.isPending ? "Đang sửa…" : "Sửa bằng AI"}
              </Button>
            </div>
            {!aiUsed && (
              <p className="ps-hint">
                Chat sửa cần trợ lý AI. Bản đang hiển thị là mẫu có sẵn — bạn cứ sửa tay trong ô
                rồi Lưu nháp.
              </p>
            )}
          </div>

          {imageUrls.length > 0 && (
            <div className="ps-images">
              <h3>
                <ImageIcon size={15} aria-hidden="true" /> Ảnh xe ({imageUrls.length}) — chọn để tải về đăng kèm
              </h3>
              <ul className="ps-image-grid">
                {imageUrls.map((path, index) => (
                  <li key={path}>
                    <button
                      type="button"
                      className={`ps-image-cell${pickedImages[path] ? " is-picked" : ""}`}
                      aria-pressed={!!pickedImages[path]}
                      onClick={() => setPickedImages((current) => ({ ...current, [path]: !current[path] }))}
                    >
                      <VehicleThumb path={path} order={index + 1} />
                    </button>
                  </li>
                ))}
              </ul>
              <Button variant="secondary" onClick={() => downloadImages.mutate()} disabled={downloadImages.isPending}>
                <Download size={15} aria-hidden="true" /> Tải ảnh đã chọn
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card className="ps-step">
        <h2>Bản nháp & duyệt</h2>
        {drafts.isPending && <Loading />}
        {drafts.isError && <ErrorState error={drafts.error} />}
        {drafts.data && !drafts.data.items.length && (
          <EmptyState title="Chưa có bản nháp" description="Tạo caption rồi bấm Lưu nháp để quay lại sửa sau." />
        )}
        <ul className="ps-draft-list">
          {(drafts.data?.items ?? []).map((draft) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              isOwner={isOwner}
              busy={setStatus.isPending}
              onLoad={() => {
                setDraftId(draft.id);
                setShowVersions(true);
                setCaptions([draft.caption]);
                setContext(null);
                setAiUsed(draft.ai_generated);
                setSourceNote(
                  draft.status === "DRAFT"
                    ? "Đang mở lại bản nháp — sửa xong nhớ Lưu lại."
                    : `Bài đã ${draftStatusLabels[draft.status]?.toLowerCase()}.`,
                );
              }}
              onApprove={() => setStatus.mutate({ id: draft.id, status: "APPROVED" })}
              onArchive={() => setStatus.mutate({ id: draft.id, status: "ARCHIVED" })}
              addLibrary={addApprovedToLibrary}
              setAddLibrary={setAddApprovedToLibrary}
            />
          ))}
        </ul>
        {showVersions && draftId && (
          <div className="ps-versions">
            <h3>
              <History size={15} aria-hidden="true" /> Lịch sử phiên bản
            </h3>
            {versions.isPending && <Loading />}
            {versions.isError && <ErrorState error={versions.error} />}
            <ol>
              {(versions.data?.items ?? []).map((version) => (
                <li key={version.id}>
                  <span className={`ps-version-source is-${version.source.toLowerCase()}`}>
                    {version.source === "AI" ? "AI" : "Người sửa"}
                  </span>
                  <p>{version.caption}</p>
                  <small>
                    {version.creator_name ?? ""} · {new Date(version.created_at).toLocaleString("vi-VN")}
                  </small>
                </li>
              ))}
            </ol>
            <Button variant="ghost" onClick={() => setShowVersions(false)}>
              Đóng lịch sử
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function VehicleThumb({ path, order }: { path: string; order: number }) {
  const query = useQuery({
    queryKey: ["vehicle-image", path],
    queryFn: () => api.imageUrl(path),
    staleTime: 4 * 60 * 1000,
  });
  return query.data ? (
    <img src={query.data} alt={`Ảnh ${order}`} loading="lazy" />
  ) : (
    <span className="ps-image-empty">{query.isError ? "Lỗi ảnh" : "…"}</span>
  );
}

function DraftRow({
  draft,
  isOwner,
  busy,
  onLoad,
  onApprove,
  onArchive,
  addLibrary,
  setAddLibrary,
}: {
  draft: PostDraft;
  isOwner: boolean;
  busy: boolean;
  onLoad: () => void;
  onApprove: () => void;
  onArchive: () => void;
  addLibrary: boolean;
  setAddLibrary: (value: boolean) => void;
}) {
  return (
    <li className="ps-draft-row">
      <div className="ps-draft-head">
        <span className={`ps-draft-status is-${draft.status.toLowerCase()}`}>
          {draftStatusLabels[draft.status] ?? draft.status}
        </span>
        <strong>{draft.vehicle_title ?? (draft.post_kind === "BUYBACK" ? "Bài thu mua" : "Bài chung")}</strong>
        <small>
          {kindOptions.find((option) => option.value === draft.post_kind)?.label} ·{" "}
          {channelOptions.find((option) => option.value === draft.channel)?.label}
          {draft.creator_name ? ` · ${draft.creator_name}` : ""}
        </small>
      </div>
      <p className="ps-draft-caption">{draft.caption}</p>
      <div className="ps-draft-actions">
        {draft.status === "DRAFT" && (
          <>
            <Button variant="secondary" onClick={onLoad}>
              Mở sửa
            </Button>
            {isOwner && (
              <>
                <label className="ps-library-check">
                  <input
                    type="checkbox"
                    checked={addLibrary}
                    onChange={(event) => setAddLibrary(event.target.checked)}
                  />
                  Thêm vào bộ nhớ thương hiệu
                </label>
                <Button onClick={() => onApprove()} disabled={busy}>
                  <Check size={15} aria-hidden="true" /> Duyệt bài
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={onArchive} disabled={busy}>
              Lưu trữ
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
