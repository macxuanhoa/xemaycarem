// Module A — "Đăng bài từ kho xe": hai bước gọn, nút hành động nằm CUỐI luồng.
//  Bước 1  Chọn xe NGÀY TRÊN TRANG KHO (chế độ pick) rồi quay lại — không nhân
//          bản danh sách xe ở đây, một nguồn dữ liệu duy nhất.
//  Bước 2  Người dùng mô tả tự do muốn đăng kiểu gì (bán/ưu đãi/cảm ơn khách đã
//          mua/kiểu marketing) → gửi NGUYÊN VĂN mô tả cho trợ lý AI cùng loại bài,
//          kênh, giọng điệu.
//  Kết quả trình bày như bài Facebook thật, và "Chuyển vào Facebook" điền sẵn
//  caption + ảnh xe sang composer (qua Cầu đăng Facebook / share sheet / dán tay).
//  Hệ thống KHÔNG tự đăng — người bán luôn là người bấm Đăng.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bike,
  Check,
  Copy,
  ExternalLink,
  History,
  ImageIcon,
  Megaphone,
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
import { briefRiskHint } from "./briefSignals";
/** Gợi ý mở lời cho ô mô tả nằm ở briefSuggestions.ts (đã test là không phạm quy tắc). */
import { briefSuggestions } from "./briefSuggestions";
import FacebookPostCard, { useVehicleImageUrl } from "./FacebookPostCard";
import {
  FacebookShareButton,
  FacebookShareSetup,
  useSharePlan,
} from "./FacebookShareButton";
import type { Vehicle } from "@/types";

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

/** Gợi ý mở lời cho ô mô tả — xem briefSuggestions.ts (đã test là không phạm quy tắc). */

/** Chỉ hai kênh Facebook dùng được Cầu đăng; Zalo dùng bảng chia sẻ/copy. */
const shareable = (channel: PostChannel) => channel !== "ZALO";

function PickedVehicle({
  vehicle,
  onClear,
}: {
  vehicle: Vehicle;
  onClear: () => void;
}) {
  const thumb = useVehicleImageUrl(vehicle.images?.[0]?.storage_path);
  return (
    <div className="ps-picked-vehicle">
      <span className="ps-picked-thumb">
        {thumb ? <img src={thumb} alt="" /> : <Bike size={22} aria-hidden="true" />}
      </span>
      <span className="ps-picked-main">
        <strong>{vehicle.vehicle_title ?? vehicle.license_plate ?? "Xe trong kho"}</strong>
        <small>
          {[vehicle.vehicle_type, vehicle.year, vehicle.color].filter(Boolean).join(" · ")}
        </small>
        <small>
          Biển số {vehicle.license_plate ?? "chưa rõ"} ·{" "}
          {vehicle.status === "SOLD" ? "đã bán (làm bài cảm ơn/đã bán)" : "đang bày bán (làm bài bán xe)"}
        </small>
      </span>
      <button type="button" className="ps-linkbtn" onClick={onClear}>
        Bỏ chọn
      </button>
    </div>
  );
}

export default function PostStudioPage() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const isOwner = profile?.role === "OWNER";
  const { plan } = useSharePlan();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [kind, setKind] = useState<PostKind>("NEW_STOCK");
  const [channel, setChannel] = useState<PostChannel>("FACEBOOK");
  const [tone, setTone] = useState<Tone>("THAN_THIEN");
  const [brief, setBrief] = useState("");
  const [groupUrl, setGroupUrl] = useState("");

  const [context, setContext] = useState<StudioContext | null>(null);
  const [captions, setCaptions] = useState<string[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [sourceNote, setSourceNote] = useState<string | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [instruction, setInstruction] = useState("");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [addApprovedToLibrary, setAddApprovedToLibrary] = useState(true);

  const storeName =
    useQuery({ queryKey: ["settings"], queryFn: () => api.call<{ store_name: string }>("get_settings") })
      .data?.store_name ?? "Cà Rem";

  // Xe chọn ở trang Kho gửi về qua router state; nạp xong thì xoá state để F5
  // không âm thầm đổi lại xe cũ khi người dùng đang sửa dở.
  const consumedPick = useRef(false);
  useEffect(() => {
    const picked = location.state?.pickedVehicle as Vehicle | undefined;
    if (!picked?.id || consumedPick.current) return;
    consumedPick.current = true;
    setVehicle(picked);
    setKind(picked.status === "SOLD" ? "SOLD" : "NEW_STOCK");
    setCaptions([]);
    setContext(null);
    setDraftId(null);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    toast.success(`Đã chọn ${picked.vehicle_title ?? picked.license_plate ?? "xe"} — mô tả kiểu bài ở bước 2 nhé.`);
  }, [location.state, location.pathname, location.search, navigate]);

  // Ảnh đính kèm mặc định = toàn bộ ảnh xe (tối đa 8, đúng giới hạn một lượt chuyển).
  useEffect(() => {
    if (!context) {
      setAttachedImages([]);
      return;
    }
    setAttachedImages(context.images.slice(0, 8).map((image) => image.storage_path));
  }, [context]);

  const imagePaths = useMemo(
    () => (context?.images ?? []).map((image) => image.storage_path).filter((path) => attachedImages.includes(path)),
    [context, attachedImages],
  );
  const allImagePaths = useMemo(() => (context?.images ?? []).map((image) => image.storage_path), [context]);
  const vehicleLabel = context
    ? (context.license_plate ?? context.vehicle_title)
    : (vehicle?.license_plate ?? vehicle?.vehicle_title);

  const needsVehicle = kind !== "BUYBACK";
  const canGenerate = !needsVehicle || !!vehicle;
  // Nhắc SỚM ở mặt giao diện; quyền chặn vẫn thuộc máy chủ (scanPublicText).
  const briefHint = useMemo(() => briefRiskHint(brief), [brief]);

  const generate = useMutation({
    mutationFn: async () => {
      if (needsVehicle && !vehicle) throw new Error("Hãy chọn chiếc xe từ Kho trước khi tạo bài.");
      const variation = captions.length ? 1 : 0;
      const ask = brief.trim().slice(0, 600);
      try {
        const result = await postStudio.assist<AssistCaptionReply>({
          task: "captions",
          consent: true,
          post_kind: kind,
          channel,
          tone,
          ...(vehicle ? { vehicle_id: vehicle.id } : {}),
          // Nguyên văn mô tả của người dùng — AI coi đó là dữ liệu, không phải lệnh.
          ...(ask ? { brief: ask } : {}),
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
      toast.success("Đã có bài ứng viên. Đọc lại hộ Cà Rem trước khi đăng nhé!");
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
    queryFn: () => postStudio.listDrafts({ limit: 8 }),
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

  const copyCaption = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Đã sao chép nội dung — dán lên Facebook/Zalo thủ công.");
    } catch {
      toast.error("Trình duyệt chặn clipboard. Hãy bôi đen và copy thủ công.");
    }
  };

  return (
    <div className="ps-page">
      <PageHeader
        title="Đăng bài từ kho xe"
        description="Chọn xe trong Kho → mô tả kiểu bài muốn đăng → xem trước như bài Facebook thật → chuyển sang Facebook để bạn kiểm tra và bấm Đăng. Hệ thống không tự đăng."
      />

      <Card className="ps-step">
        <h2>
          <Megaphone size={16} aria-hidden="true" /> 1 · Chọn xe từ Kho
        </h2>
        {vehicle ? (
          <PickedVehicle
            vehicle={vehicle}
            onClear={() => {
              setVehicle(null);
              setContext(null);
              setCaptions([]);
              setDraftId(null);
            }}
          />
        ) : (
          <div className="ps-kho-cta">
            <Button
              onClick={() => navigate("/vehicles?pick=post&return=/posts")}
              aria-label="Chọn xe từ Kho để đăng bài"
            >
              <Bike size={16} aria-hidden="true" /> Chọn xe từ Kho
            </Button>
            <button type="button" className="ps-linkbtn" onClick={() => setKind("BUYBACK")}>
              Đăng bài tìm thu mua (không cần chọn xe)
            </button>
          </div>
        )}
        <p className="ps-kho-note">
          Sang Kho là chế độ chọn: chỉ tìm và Chọn (xem được chi tiết), không sửa dữ liệu xe.
          Xe <strong>đang bày bán</strong> → bài bán/ưu đãi; xe <strong>đã bán</strong> → bài cảm ơn,
          khoe xe vừa giao, và nhiều kiểu marketing khác.
        </p>
      </Card>

      <Card className="ps-step">
        <h2>2 · Bạn muốn đăng kiểu gì?</h2>
        <Field label="Mô tả tự do cho trợ lý AI">
          <textarea
            id="ps-brief"
            className="ps-brief"
            value={brief}
            maxLength={600}
            rows={4}
            placeholder="VD: Viết bài cảm ơn anh khách mua Wave Alpha tối qua, giọng thân thiện, nhắc quán hỗ trợ sang tên miễn phí…"
            onChange={(event) => setBrief(event.target.value)}
          />
          <p className="ps-hint">
            Càng cụ thể càng tốt. Mô tả được gửi nguyên văn cho trợ lý viết bài, coi như dữ liệu
            tham khảo — không phải lệnh hệ thống.
          </p>
          {briefHint && (
            <p className="ps-hint is-warn" role="status">
              {briefHint}
            </p>
          )}
        </Field>
        <div className="ps-chiprow" role="group" aria-label="Gợi ý mở lời">
          {briefSuggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              className={`ps-chip${brief.trim() === suggestion.text ? " is-active" : ""}`}
              aria-pressed={brief.trim() === suggestion.text}
              onClick={() => setBrief(suggestion.text)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>

        <Field label="Loại bài">
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
        </Field>

        <Field label="Nơi đăng">
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
        </Field>
        {channel === "FB_GROUP" && (
          <Field label="Link hội nhóm">
            <input
              type="url"
              value={groupUrl}
              onChange={(event) => setGroupUrl(event.target.value.trim())}
              placeholder="https://www.facebook.com/groups/…"
            />
            <p className="ps-hint">
              Dạng https://www.facebook.com/groups/… — Cầu đăng sẽ mở đúng nhóm này.
            </p>
          </Field>
        )}
        {channel === "ZALO" && (
          <p className="ps-hint">
            Zalo không dùng Cầu đăng Facebook. Bản này hợp để sao chép hoặc mở bảng chia sẻ của
            điện thoại rồi chọn Zalo.
          </p>
        )}

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

        {/* Nút tạo bài nằm CUỐI luồng (không dính tiêu đề) để đọc xong rồi mới bấm. */}
        <div className="ps-cta-row">
          {!canGenerate && <span className="ps-hint">Chọn xe ở bước 1 trước đã.</span>}
          <Button
            onClick={() => generate.mutate()}
            disabled={generate.isPending || !canGenerate}
          >
            <Sparkles size={16} aria-hidden="true" />
            {generate.isPending ? "Đang viết…" : captions.length ? "Tạo lại bài" : "Tạo bài viết"}
          </Button>
        </div>
      </Card>

      {captions.length > 0 && (
        <Card className="ps-step">
          <h2>
            <ImageIcon size={16} aria-hidden="true" /> 3 · Xem trước &amp; chuyển sang Facebook
          </h2>
          {sourceNote && <p className="ps-source">{sourceNote}</p>}
          {allImagePaths.length > 0 && (
            <>
              <h3>Ảnh đính kèm ({attachedImages.length}/{allImagePaths.length})</h3>
              <ul className="ps-image-grid">
                {allImagePaths.map((path, index) => (
                  <li key={path}>
                    <button
                      type="button"
                      className={`ps-image-cell${attachedImages.includes(path) ? " is-picked" : ""}`}
                      aria-pressed={attachedImages.includes(path)}
                      aria-label={`Ảnh ${index + 1}${attachedImages.includes(path) ? " đang được đính kèm" : " không đính kèm"}`}
                      onClick={() =>
                        setAttachedImages((current) =>
                          current.includes(path)
                            ? current.filter((item) => item !== path)
                            : [...current, path],
                        )
                      }
                    >
                      <VehicleThumb path={path} order={index + 1} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {captions.map((caption, index) => (
            <FacebookPostCard
              key={`${caption.slice(0, 24)}-${index}`}
              caption={caption}
              authorName={storeName}
              metaLine={`Bây giờ · ${channel === "FB_GROUP" ? "Hội nhóm" : "Công khai"}`}
              imagePaths={imagePaths}
              ariaLabel={`Caption ứng viên ${index + 1}`}
              onEdit={(value) =>
                setCaptions((current) => current.map((item, i) => (i === index ? value : item)))
              }
              footer={
                <>
                  {shareable(channel) && (
                    <FacebookShareButton
                      caption={caption}
                      imagePaths={imagePaths}
                      vehicleLabel={vehicleLabel ?? undefined}
                      channel={channel}
                      groupUrl={groupUrl || undefined}
                      label={channel === "FB_GROUP" ? "Chuyển vào nhóm" : "Chuyển vào Facebook"}
                    />
                  )}
                  <Button variant="secondary" onClick={() => saveDraft.mutate(caption)} disabled={saveDraft.isPending}>
                    <Check size={15} aria-hidden="true" />
                    {saveDraft.isPending && saveDraft.variables === caption
                      ? "Đang lưu…"
                      : draftId
                        ? "Lưu lại nháp"
                        : "Lưu nháp"}
                  </Button>
                  <Button variant="ghost" onClick={() => void copyCaption(caption)}>
                    <Copy size={15} aria-hidden="true" /> Sao chép
                  </Button>
                </>
              }
            />
          ))}

          {plan && plan.platform === "desktop" && !plan.extensionReady && <FacebookShareSetup platform={plan.platform} />}
          {plan && shareable(channel) && (
            <p className="ps-hint">
              {`Cách sẽ dùng: ${plan.choice.reason}`}
            </p>
          )}

          <div className="ps-chat">
            <h3>Chat sửa bài</h3>
            {turns.length > 0 && (
              <ul className="ps-chat-log">
                {turns.map((turn, turnIndex) => (
                  <li key={turnIndex} className={`ps-turn is-${turn.role}`}>
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
        </Card>
      )}

      <Card className="ps-step">
        <h2>
          <ExternalLink size={16} aria-hidden="true" /> Bản nháp chờ duyệt
        </h2>
        <p className="ps-hint">
          Mỗi bài hiện đúng như trên Facebook. Chọn bài ưng ý rồi bấm “Xác nhận &amp; chuyển vào
          Facebook”: Cầu đăng điền sẵn chữ + ảnh xe vào ô soạn thảo, bạn kiểm tra và tự bấm Đăng.
        </p>
        {drafts.isPending && <Loading />}
        {drafts.isError && <ErrorState error={drafts.error} />}
        {drafts.data && !drafts.data.items.length && (
          <EmptyState title="Chưa có bản nháp" description="Tạo bài rồi bấm Lưu nháp để quay lại sửa sau." />
        )}
        {(drafts.data?.items ?? []).map((draft) => (
          <DraftPostCard
            key={draft.id}
            draft={draft}
            isOwner={isOwner}
            storeName={storeName}
            busy={setStatus.isPending}
            addLibrary={addApprovedToLibrary}
            setAddLibrary={setAddApprovedToLibrary}
            onLoad={() => {
              setDraftId(draft.id);
              setShowVersions(true);
              setCaptions([draft.caption]);
              setKind(draft.post_kind);
              setChannel(draft.channel);
              setAiUsed(draft.ai_generated);
              setSourceNote(
                draft.status === "DRAFT"
                  ? "Đang mở lại bản nháp — sửa xong nhớ Lưu lại."
                  : `Bài đã ${draftStatusLabels[draft.status]?.toLowerCase() ?? draft.status}.`,
              );
              if (draft.vehicle_id) void postStudio.context(draft.vehicle_id).then(setContext).catch(() => setContext(null));
            }}
            onApprove={() => setStatus.mutate({ id: draft.id, status: "APPROVED" })}
            onArchive={() => setStatus.mutate({ id: draft.id, status: "ARCHIVED" })}
            onVersioned={() => {
              setDraftId(draft.id);
              setShowVersions((open) => !open);
            }}
          />
        ))}
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
  const url = useVehicleImageUrl(path);
  return url ? (
    <img src={url} alt={`Ảnh ${order}`} loading="lazy" />
  ) : (
    <span className="ps-image-empty">…</span>
  );
}

/**
 * Một bản nháp trưng bày như bài Facebook, ảnh lấy từ xe của chính bản nháp
 * (RPC `get_post_studio_context` — cùng nguồn Tier-A như lúc tạo bài).
 */
function DraftPostCard({
  draft,
  isOwner,
  storeName,
  busy,
  addLibrary,
  setAddLibrary,
  onLoad,
  onApprove,
  onArchive,
  onVersioned,
}: {
  draft: PostDraft;
  isOwner: boolean;
  storeName: string;
  busy: boolean;
  addLibrary: boolean;
  setAddLibrary: (value: boolean) => void;
  onLoad: () => void;
  onApprove: () => void;
  onArchive: () => void;
  onVersioned: () => void;
}) {
  const context = useQuery({
    queryKey: ["post-studio-context", draft.vehicle_id],
    queryFn: () => postStudio.context(draft.vehicle_id as string),
    enabled: !!draft.vehicle_id,
    staleTime: 5 * 60 * 1000,
  });
  const imagePaths = (context.data?.images ?? []).map((image) => image.storage_path);
  const kindLabel = kindOptions.find((option) => option.value === draft.post_kind)?.label ?? draft.post_kind;
  const channelLabel = channelOptions.find((option) => option.value === draft.channel)?.label ?? draft.channel;

  return (
    <FacebookPostCard
      caption={draft.caption}
      authorName={storeName}
      metaLine={`${new Date(draft.created_at).toLocaleString("vi-VN")} · ${kindLabel} · ${channelLabel}${draft.vehicle_title ? ` · ${draft.vehicle_title}` : ""}${draft.creator_name ? ` · ${draft.creator_name}` : ""}`}
      imagePaths={imagePaths}
      ariaLabel={`Bản nháp ${draft.id.slice(0, 8)}`}
      badge={
        <span className={`ps-draft-status is-${draft.status.toLowerCase()}`}>
          {draftStatusLabels[draft.status] ?? draft.status}
        </span>
      }
      footer={
        <>
          {shareable(draft.channel) && (
            <FacebookShareButton
              variant="secondary"
              caption={draft.caption}
              imagePaths={imagePaths}
              vehicleLabel={draft.vehicle_title ?? undefined}
              channel={draft.channel}
              label="Xác nhận & chuyển vào Facebook"
            />
          )}
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
                  <Button onClick={onApprove} disabled={busy}>
                    <Check size={15} aria-hidden="true" /> Duyệt bài
                  </Button>
                </>
              )}
              <Button variant="ghost" onClick={onArchive} disabled={busy}>
                Lưu trữ
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={onVersioned}>
            <History size={15} aria-hidden="true" /> Phiên bản
          </Button>
        </>
      }
    />
  );
}
