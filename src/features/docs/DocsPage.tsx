import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, Search, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { Card, EmptyState, ErrorState, Loading, PageHeader } from "@/components/ui";
import { MarkdownLite } from "@/lib/markdownLite";
import { useAuth } from "@/features/auth/AuthProvider";
import { isOwner } from "@/lib/permissions";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import type { KnowledgeAudience, KnowledgeIndexItem } from "@/types";

type DocRow = KnowledgeIndexItem & { excerpt?: string };

const audienceLabels: Record<KnowledgeAudience, string> = {
  ALL: "Mọi người",
  STAFF: "Nhân viên",
  MANAGER: "Quản lý",
  OWNER: "Chủ cửa hàng",
};

/** High-level shelves the index is sorted into, so readers browse by purpose
 *  instead of by raw file name. */
type DocCategory =
  | "GUIDE"
  | "OPS"
  | "SYSTEM"
  | "AI"
  | "SECURITY"
  | "QA"
  | "PROJECT"
  | "OTHER";

const categoryMeta: Record<DocCategory, { label: string; order: number }> = {
  GUIDE: { label: "Hướng dẫn & Quy trình nội bộ", order: 10 },
  OPS: { label: "Vận hành & Phát hành", order: 20 },
  SYSTEM: { label: "Hệ thống & Kiến trúc", order: 30 },
  AI: { label: "Trợ lý AI", order: 40 },
  SECURITY: { label: "An toàn & Đăng nhập", order: 50 },
  QA: { label: "Kiểm thử & Chất lượng trải nghiệm", order: 60 },
  PROJECT: { label: "Dự án & Triển khai", order: 70 },
  OTHER: { label: "Tài liệu khác", order: 900 },
};

/** Friendly Vietnamese names for the raw doc file paths, each assigned to a
 *  shelf with an order so the most-referenced playbooks surface first.
 *  Keyed by uppercase basename. */
const sourceMeta: Record<
  string,
  { label: string; order: number; category: DocCategory }
> = {
  "README.MD": { label: "Tổng quan cửa hàng", order: 10, category: "GUIDE" },
  "INTERNALSOPS.MD": { label: "Quy trình nội bộ", order: 20, category: "GUIDE" },
  "OPERATIONS.MD": { label: "Vận hành hằng ngày", order: 30, category: "OPS" },
  "SOPS.MD": { label: "Vận hành hằng ngày", order: 30, category: "OPS" },
  "PRODUCTIONRELEASE.MD": { label: "Phát hành production", order: 80, category: "OPS" },
  "SYSTEMREFERENCE.MD": { label: "Tham chiếu hệ thống", order: 40, category: "SYSTEM" },
  "DECISIONS.MD": { label: "Quyết định kỹ thuật", order: 60, category: "SYSTEM" },
  "COMMUNICATIONARCHITECTURE.MD": { label: "Liên lạc & thông báo", order: 70, category: "SYSTEM" },
  "PRODUCTIONSHEMADRIFT.MD": { label: "Sai lệch schema", order: 150, category: "SYSTEM" },
  "API.MD": { label: "Tài liệu API", order: 180, category: "SYSTEM" },
  "AIASSISTCONTRACT.MD": { label: "Trợ lý AI & trích dẫn", order: 50, category: "AI" },
  "AGENTHANDOFF.MD": { label: "Bàn giao cho cộng sự", order: 90, category: "AI" },
  "SECURITY.MD": { label: "An toàn & phân quyền", order: 190, category: "SECURITY" },
  "AUTHACCEPTANCEREPORT.MD": { label: "Nghiệm thu đăng nhập", order: 160, category: "SECURITY" },
  "AUTHRECOVERYAUDIT.MD": { label: "Khôi phục đăng nhập", order: 165, category: "SECURITY" },
  "AUTHBACKUPMETADATA.MD": { label: "Sao lưu đăng nhập", order: 170, category: "SECURITY" },
  "VERIFICATION.MD": { label: "Kiểm chứng & kiểm thử", order: 130, category: "QA" },
  "KNOWNISSUES.MD": { label: "Lỗi đã biết", order: 140, category: "QA" },
  "UXFRICTIONAUDIT.MD": { label: "Tinh chỉnh trải nghiệm", order: 120, category: "QA" },
  "PROJECTSTATE.MD": { label: "Trạng thái dự án", order: 100, category: "PROJECT" },
  "IMPLEMENTATIONPLAN.MD": { label: "Kế hoạch triển khai", order: 110, category: "PROJECT" },
  "IMPLEMENTATIONREPORT.MD": { label: "Báo cáo triển khai", order: 115, category: "PROJECT" },
};

function sourceMetaFor(path: string): {
  label: string;
  order: number;
  category: DocCategory;
} {
  const base = (path.split("/").pop() ?? path).toUpperCase();
  const known = sourceMeta[base];
  if (known) return known;
  const pretty = (path.split("/").pop() ?? path)
    .replace(/\.(md|markdown|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return {
    label: pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : "Tài liệu khác",
    order: 500,
    category: "OTHER",
  };
}

/** Documents the store keeps about itself, served from the database and read under RLS. */
export default function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const { profile } = useAuth();
  const [term, setTerm] = useState("");
  // Open shelves tracked per category; absent entries fall back to the
  // remembered/default state below. `<details>` needs controlled `open`
  // because React has no defaultOpen for it.
  const [openShelves, setOpenShelves] = useState<Partial<Record<DocCategory, boolean>>>({});
  const query = useDebouncedValue(term.trim(), 300);
  const index = useQuery({
    queryKey: ["knowledge-index"],
    queryFn: () => api.listKnowledge(),
  });
  // OWNER sees what the copilot could not answer yet; retry stays off because the
  // RPC is missing until the copilot_question_gaps migration is applied.
  const gaps = useQuery({
    queryKey: ["copilot-gaps"],
    queryFn: () => api.listCopilotGaps(30),
    enabled: Boolean(profile && isOwner(profile)),
    retry: false,
  });
  const search = useQuery({
    queryKey: ["knowledge-search", query],
    queryFn: () => api.searchKnowledge(query, 20),
    enabled: query.length >= 2,
  });
  const article = useQuery({
    queryKey: ["knowledge-article", slug],
    queryFn: () => api.getKnowledgeArticle(slug as string),
    enabled: Boolean(slug),
  });

  const items: DocRow[] =
    query.length >= 2 ? (search.data ?? []) : (index.data?.items ?? []);
  // Two-level shelf: category first, then the curated file order inside it,
  // so readers browse by purpose instead of scanning twenty file-name groups.
  const byCategory = items.reduce<Map<DocCategory, Map<string, DocRow[]>>>(
    (shelves, item) => {
      const source = item.source_path ?? "Tài liệu khác";
      const category = sourceMetaFor(source).category;
      const files = shelves.get(category) ?? new Map<string, DocRow[]>();
      files.set(source, [...(files.get(source) ?? []), item]);
      shelves.set(category, files);
      return shelves;
    },
    new Map(),
  );
  const sortedCategories = [...byCategory.entries()].sort(
    ([a], [b]) => categoryMeta[a].order - categoryMeta[b].order,
  );
  // Order files by curated priority, then alphabetically, so the store banner
  // surfaces the playbooks people reach for most.
  const sortFiles = ([a]: [string, DocRow[]], [b]: [string, DocRow[]]) => {
    const ma = sourceMetaFor(a);
    const mb = sourceMetaFor(b);
    return ma.order - mb.order || ma.label.localeCompare(mb.label, "vi");
  };
  const searching = query.length >= 2;
  // Search hits bypass the shelves entirely: results render as a flat list of
  // file cards so nothing hides behind a collapsed toggle (and programmatic
  // `<details>` opens never pollute the remembered shelf state).
  const flatFiles = [...byCategory.values()]
    .flatMap((files) => [...files.entries()])
    .sort(sortFiles);
  const renderFileGroups = (files: [string, DocRow[]][]) =>
    files.map(([source, entries]) => {
      const meta = sourceMetaFor(source);
      return (
        <article key={source} className="docs-group">
          <h3 className="docs-group-title">
            <span className="docs-group-name">{meta.label}</span>
            <span className="docs-group-count">{entries.length}</span>
          </h3>
          <ul className="docs-list">
            {entries.map((entry) => (
              <li key={entry.slug}>
                <Link to={`/docs/${entry.slug}`}>
                  <BookOpen size={16} aria-hidden="true" />
                  <span>
                    <strong>{entry.section ?? entry.title}</strong>
                    {/* The copilot cites the document title, so the index must show it too. */}
                    {entry.section ? <small className="muted">{entry.title}</small> : null}
                    {entry.excerpt ? (
                      <small className="muted">{entry.excerpt}</small>
                    ) : null}
                  </span>
                  <em className="docs-tier">{audienceLabels[entry.audience]}</em>
                </Link>
              </li>
            ))}
          </ul>
        </article>
      );
    });

  return (
    <div className="stack">
      <PageHeader
        title="Tài liệu cửa hàng"
        description="Quy trình, vận hành và quyết định kỹ thuật đang được dùng làm bằng chứng cho Trợ lý AI."
      />

      {slug ? (
        article.isPending ? (
          <Loading />
        ) : article.error ? (
          <Card>
            <ErrorState error={article.error} />
            <Link className="carem-btn" to="/docs">
              Về danh sách tài liệu
            </Link>
          </Card>
        ) : (
          <Card>
            <h1 className="section-title">{article.data.title}</h1>
            <p className="muted">
              {audienceLabels[article.data.audience]}
              {article.data.source_path ? ` · ${article.data.source_path}` : ""}
              {article.data.section ? ` · mục: ${article.data.section}` : ""}
            </p>
            <MarkdownLite text={article.data.body_md} className="doc-body" />
            <Link className="carem-btn" to="/copilot">
              <Sparkles size={16} aria-hidden="true" /> Hỏi AI về tài liệu này
            </Link>
          </Card>
        )
      ) : (
        <Card>
          <label className="docs-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={term}
              placeholder="Tìm trong tài liệu: tồn kho, sao lưu, thanh toán…"
              onChange={(event) => setTerm(event.target.value)}
              aria-label="Tìm trong tài liệu"
            />
          </label>
          {query.length >= 2 && search.isFetching && <Loading />}
          {items.length === 0 ? (
            <EmptyState
              title="Chưa tìm thấy trang nào"
              description="Thử từ khóa ngắn hơn, hoặc mở danh sách đầy đủ bên dưới."
            />
          ) : searching ? (
            <div className="docs-groups">{renderFileGroups(flatFiles)}</div>
          ) : (
            <div className="docs-categories">
              {sortedCategories.map(([category, files], index) => {
                const fileGroups = [...files.entries()].sort(sortFiles);
                const total = fileGroups.reduce(
                  (count, [, entries]) => count + entries.length,
                  0,
                );
                // Shelves stay collapsed to keep the page short; the visitor's
                // choices persist per device, and only the first shelf starts
                // open for newcomers.
                const remembered = localStorage.getItem(`docs-category:${category}`);
                const shelfOpen =
                  openShelves[category] ??
                  (remembered !== null ? remembered === "1" : index === 0);
                return (
                  <details
                    key={category}
                    className="docs-category"
                    open={shelfOpen}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setOpenShelves((old) =>
                        old[category] === open ? old : { ...old, [category]: open },
                      );
                      localStorage.setItem(`docs-category:${category}`, String(open));
                    }}
                  >
                    <summary className="docs-category-title">
                      <ChevronDown size={16} className="docs-category-chevron" aria-hidden="true" />
                      <span className="docs-category-name">
                        {categoryMeta[category].label}
                      </span>
                      <span className="docs-group-count">{total}</span>
                    </summary>
                    <div className="docs-groups">{renderFileGroups(fileGroups)}</div>
                  </details>
                );
              })}
            </div>
          )}
          <p className="muted">
            {index.data ? `${index.data.total} phần tài liệu bạn được đọc. ` : ""}
            AI chỉ trích dẫn những trang nằm trong danh sách này.
          </p>
        </Card>
      )}

      {!slug && profile && isOwner(profile) && (gaps.data?.items.length ?? 0) > 0 && (
        <Card>
          <h2 className="section-title">Câu hỏi chưa có tài liệu</h2>
          <p className="muted">
            {gaps.data!.total} câu hỏi trong {gaps.data!.days} ngày qua mà Trợ lý AI
            không tìm được bằng chứng. Câu nào lặp lại nhiều lần là dấu hiệu cần viết
            ngay một quy trình vào <code>docs/INTERNAL_SOPS.md</code>, sau đó chạy{" "}
            <code>npm run knowledge:seed</code>.
          </p>
          <ul className="docs-list">
            {gaps.data!.items.map((gap) => (
              <li key={gap.id}>
                <span>
                  <strong>{gap.question}</strong>
                  <small className="muted">Lần gần nhất: {new Date(gap.last_seen_at).toLocaleDateString("vi-VN")}</small>
                </span>
                <em className="docs-tier">Gặp {gap.hits} lần</em>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
