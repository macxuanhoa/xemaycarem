import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Search, Sparkles } from "lucide-react";
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

/** Friendly Vietnamese names for the raw doc file paths, with a grouping order so
 *  the most-referenced playbooks surface first. Keyed by uppercase basename. */
const sourceMeta: Record<string, { label: string; order: number }> = {
  "README.MD": { label: "Tổng quan cửa hàng", order: 10 },
  "INTERNALSOPS.MD": { label: "Quy trình nội bộ", order: 20 },
  "OPERATIONS.MD": { label: "Vận hành hằng ngày", order: 30 },
  "SOPS.MD": { label: "Vận hành hằng ngày", order: 30 },
  "SYSTEMREFERENCE.MD": { label: "Tham chiếu hệ thống", order: 40 },
  "AIASSISTCONTRACT.MD": { label: "Trợ lý AI & trích dẫn", order: 50 },
  "DECISIONS.MD": { label: "Quyết định kỹ thuật", order: 60 },
  "COMMUNICATIONARCHITECTURE.MD": { label: "Liên lạc & thông báo", order: 70 },
  "PRODUCTIONRELEASE.MD": { label: "Phát hành production", order: 80 },
  "AGENTHANDOFF.MD": { label: "Bàn giao cho cộng sự", order: 90 },
  "PROJECTSTATE.MD": { label: "Trạng thái dự án", order: 100 },
  "IMPLEMENTATIONPLAN.MD": { label: "Kế hoạch triển khai", order: 110 },
  "IMPLEMENTATIONREPORT.MD": { label: "Báo cáo triển khai", order: 115 },
  "UXFRICTIONAUDIT.MD": { label: "Tinh chỉnh trải nghiệm", order: 120 },
  "VERIFICATION.MD": { label: "Kiểm chứng & kiểm thử", order: 130 },
  "KNOWNISSUES.MD": { label: "Lỗi đã biết", order: 140 },
  "PRODUCTIONSHEMADRIFT.MD": { label: "Sai lệch schema", order: 150 },
  "AUTHACCEPTANCEREPORT.MD": { label: "Nghiệm thu đăng nhập", order: 160 },
  "AUTHRECOVERYAUDIT.MD": { label: "Khôi phục đăng nhập", order: 165 },
  "AUTHBACKUPMETADATA.MD": { label: "Sao lưu đăng nhập", order: 170 },
  "API.MD": { label: "Tài liệu API", order: 180 },
  "SECURITY.MD": { label: "An toàn & phân quyền", order: 190 },
};

function sourceMetaFor(path: string): { label: string; order: number } {
  const base = (path.split("/").pop() ?? path).toUpperCase();
  const known = sourceMeta[base];
  if (known) return known;
  const pretty = (path.split("/").pop() ?? path)
    .replace(/\.(md|markdown|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return { label: pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : "Tài liệu khác", order: 500 };
}

/** Documents the store keeps about itself, served from the database and read under RLS. */
export default function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const { profile } = useAuth();
  const [term, setTerm] = useState("");
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
  const groups = items.reduce<Record<string, DocRow[]>>((accumulator, item) => {
    const key = item.source_path ?? "Tài liệu khác";
    (accumulator[key] ??= []).push(item);
    return accumulator;
  }, {});
  // Order groups by curated priority, then alphabetically, so the store banner
  // surfaces the playbooks people reach for most.
  const sortedGroups = Object.entries(groups).sort(([a], [b]) => {
    const ma = sourceMetaFor(a);
    const mb = sourceMetaFor(b);
    return ma.order - mb.order || ma.label.localeCompare(mb.label, "vi");
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
          {Object.keys(groups).length === 0 ? (
            <EmptyState
              title="Chưa tìm thấy trang nào"
              description="Thử từ khóa ngắn hơn, hoặc mở danh sách đầy đủ bên dưới."
            />
          ) : (
            <div className="docs-groups">
              {sortedGroups.map(([source, entries]) => {
                const meta = sourceMetaFor(source);
                return (
                  <section key={source} className="docs-group">
                    <h2 className="docs-group-title">
                      <span className="docs-group-name">{meta.label}</span>
                      <span className="docs-group-count">{entries.length}</span>
                    </h2>
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
                  </section>
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
