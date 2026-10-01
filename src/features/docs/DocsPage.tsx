import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Search, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { Card, EmptyState, ErrorState, Loading, PageHeader } from "@/components/ui";
import { MarkdownLite } from "@/lib/markdownLite";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import type { KnowledgeAudience, KnowledgeIndexItem } from "@/types";

type DocRow = KnowledgeIndexItem & { excerpt?: string };

const audienceLabels: Record<KnowledgeAudience, string> = {
  ALL: "Mọi người",
  STAFF: "Nhân viên",
  MANAGER: "Quản lý",
  OWNER: "Chủ cửa hàng",
};

/** Documents the store keeps about itself, served from the database and read under RLS. */
export default function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const [term, setTerm] = useState("");
  const query = useDebouncedValue(term.trim(), 300);
  const index = useQuery({
    queryKey: ["knowledge-index"],
    queryFn: () => api.listKnowledge(),
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
              {Object.entries(groups).map(([source, entries]) => (
                <section key={source}>
                  <h2 className="section-title">{source}</h2>
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
              ))}
            </div>
          )}
          <p className="muted">
            {index.data ? `${index.data.total} phần tài liệu bạn được đọc. ` : ""}
            AI chỉ trích dẫn những trang nằm trong danh sách này.
          </p>
        </Card>
      )}
    </div>
  );
}
