import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Bike,
  BookOpen,
  ClipboardList,
  Contact,
  Gauge,
  Receipt,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import type { CopilotCitation, CopilotCitationType } from "@/types";

/** Icons make an evidence button recognisable without reading its label. */
const icons: Record<CopilotCitationType, typeof Bike> = {
  vehicle: Bike,
  sale: Receipt,
  debt: Wallet,
  expense: ClipboardList,
  metric: Gauge,
  audit: ShieldCheck,
  profile: Users,
  document: BookOpen,
  settings: Settings,
  customer: Contact,
};

export const citationTypeLabels: Record<CopilotCitationType, string> = {
  vehicle: "Xe",
  sale: "Bán hàng",
  debt: "Công nợ",
  expense: "Chi phí",
  metric: "Số liệu",
  audit: "Lịch sử",
  profile: "Tài khoản",
  document: "Tài liệu",
  settings: "Cài đặt",
  customer: "Khách hàng",
};

const currentStockLabels = new Set([
  "Xe đang tồn kho",
  "Xe đang giữ chỗ",
  "Xe chưa xác nhận giá mua",
  "Xe tồn trên 60 ngày",
]);

export const isCurrentStockCitation = (citation: CopilotCitation) =>
  citation.type === "metric" &&
  citation.route === "/vehicles" &&
  currentStockLabels.has(citation.label);

export const citationSourceLabel = (citation: CopilotCitation) =>
  `${citationTypeLabels[citation.type]}: ${citation.label}`;

const sourceDetail = (citation: CopilotCitation) =>
  isCurrentStockCitation(citation) ? "Tồn kho hiện tại" : citation.detail;

/** Citation IDs stay internal; people see the source they will open. */
export function CitationChip({ citation }: { citation: CopilotCitation }) {
  const Icon = icons[citation.type];
  const detail = sourceDetail(citation);
  return (
    <Link
      className="citation-chip"
      to={citation.route}
      aria-label={`Mở nguồn ${citationSourceLabel(citation)}`}
      title={`${citationSourceLabel(citation)}${detail ? ` · ${detail}` : ""}`}
    >
      <Icon size={12} aria-hidden="true" />
      <span>{citation.label}</span>
    </Link>
  );
}

/** Turn citation markers into clickable chips for the Markdown renderer. */
export function citationNodes(
  citations: CopilotCitation[],
): Record<string, ReactNode> {
  return Object.fromEntries(
    citations.map((citation) => [
      citation.id,
      <CitationChip key={citation.id} citation={citation} />,
    ]),
  );
}

/** The evidence panel under an answer: one row per source, each one opening. */
export function CitationList({ citations }: { citations: CopilotCitation[] }) {
  if (!citations.length) return null;
  return (
    <ul className="citation-list">
      {citations.map((citation) => {
        const Icon = icons[citation.type];
        return (
          <li key={citation.id}>
            <span className="citation-icon" aria-hidden="true">
              <Icon size={16} />
            </span>
            <span className="citation-text">
              <strong>{citation.label}</strong>
              <small>
                {citationTypeLabels[citation.type]}
                {sourceDetail(citation) ? ` · ${sourceDetail(citation)}` : ""}
              </small>
            </span>
            <Link
              className="citation-open"
              to={citation.route}
              aria-label={`Mở nguồn ${citationSourceLabel(citation)}`}
            >
              Mở nguồn
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
