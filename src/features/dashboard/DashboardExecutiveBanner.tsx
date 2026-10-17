import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Bike,
  Plus,
  ScanLine,
  Sparkles,
} from "lucide-react";
import { canOperate } from "@/lib/permissions";
import type { Profile } from "@/types";

interface DashboardExecutiveBannerProps {
  profile: Profile | null;
  storeName?: string;
}

export function DashboardExecutiveBanner({
  profile,
  storeName = "Cửa hàng Xe Máy Cà Rem",
}: DashboardExecutiveBannerProps) {
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return { text: "Chào buổi sáng", icon: "☀️" };
    if (hour >= 12 && hour < 18) return { text: "Chào buổi chiều", icon: "🌤️" };
    return { text: "Chào buổi tối", icon: "🌙" };
  }, []);

  const firstName = profile?.full_name?.split(" ").at(-1) ?? "bạn";

  return (
    <div className="carem-hero-banner" role="region" aria-label="Bảng tổng quan Cà Rem">
      {/* Ambient background decoration */}
      <div className="carem-banner-glow" aria-hidden="true" />

      <div className="carem-banner-inner">
        {/* Top bar of banner */}
        <div className="carem-banner-top">
          <div className="carem-banner-heading">
            <div className="carem-banner-badges">
              <span className="carem-badge-store">
                <span className="carem-pulse-dot" aria-hidden="true" />
                {storeName}
              </span>
              <span className="carem-badge-greeting">
                {greeting.text} {greeting.icon}
              </span>
            </div>

            <h1 className="carem-banner-title">
              Xin chào, <span className="carem-name-highlight">{firstName}</span>
            </h1>
            <p className="carem-banner-subtitle">
              Hệ thống quản lý kho xe, bán hàng &amp; dòng tiền Cà Rem Hội An
            </p>
          </div>
        </div>

        {/* Operational Action Dock */}
        <div className="carem-banner-actions">
          {canOperate(profile) && (
            <Link to="/acquisitions/new" className="carem-btn carem-btn-lime">
              <Plus size={16} strokeWidth={2.5} />
              <span>Thu xe mới</span>
            </Link>
          )}

          {canOperate(profile) && (
            <Link to="/sell" className="carem-btn carem-btn-glass">
              <ArrowUpRight size={16} />
              <span>Bán xe</span>
            </Link>
          )}

          <Link to="/vehicles" className="carem-btn carem-btn-glass">
            <Bike size={16} />
            <span>Kho xe</span>
          </Link>

          <Link to="/capture" className="carem-btn carem-btn-glass">
            <ScanLine size={16} />
            <span>Quét / Chụp</span>
          </Link>

          {/* Trợ lý Cà Rem là mặt phẳng AI duy nhất ở /assistant (đã gộp trang
              "Tra cứu AI" cũ); /assist cũ vẫn còn cho luồng bản nháp thủ công. */}
          <Link to="/assistant" className="carem-btn carem-btn-sparkle">
            <Sparkles size={15} />
            <span>Hỏi Cà Rem AI</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
