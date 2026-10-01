import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bike,
  BookOpen,
  ClipboardList,
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
};

/**
 * The inline `[c1]` marker inside an answer. It navigates to the very screen
 * where the figure is shown, so any claim can be re-checked in one tap.
 */
export function CitationChip({ citation }: { citation: CopilotCitation }) {
  const navigate = useNavigate();
  const Icon = icons[citation.type];
  return (
    <button
      type="button"
      className="citation-chip"
      onClick={() => navigate(citation.route)}
      title={`${citationTypeLabels[citation.type]}: ${citation.label}${citation.detail ? ` (${citation.detail})` : ""}`}
    >
      <Icon size={12} aria-hidden="true" />
      <span>{citation.id}</span>
      <span className="sr-only">Mở bằng chứng {citation.id}</span>
    </button>
  );
}

/** Turn citation markers into clickable chips for the Markdown renderer. */
export function citationNodes(citations: CopilotCitation[]): Record<string, ReactNode> {
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
                {citation.detail ? ` · ${citation.detail}` : ""}
              </small>
            </span>
            <Link className="citation-open" to={citation.route}>
              Mở bằng chứng {citation.id}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
