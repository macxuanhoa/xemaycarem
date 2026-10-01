import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Bike,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Handshake,
  Lock,
  MapPin,
  Menu,
  MessageCircle,
  PhoneCall,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  Tag,
  X,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import "@/styles-showroom.css";

export type ShowroomBike = {
  id: string;
  name: string;
  brand: string;
  category: "scooter" | "manual" | "sports";
  year: number;
  price: number;
  condition: string;
  plate: string;
  odo: string;
  color: string;
  image: string;
  isNew?: boolean;
  featured?: boolean;
  specs: {
    engine: string;
    fuel: string;
    warranty: string;
    origin: string;
  };
  description: string;
};

const FEATURED_BIKES: ShowroomBike[] = [
  {
    id: "sh-150-white-2023",
    name: "Honda SH 150i ABS",
    brand: "Honda",
    category: "scooter",
    year: 2023,
    price: 89000000,
    condition: "99% Mới cứng - Máy nguyên zin",
    plate: "92-B1 221.33 (Hội An)",
    odo: "8.200 km",
    color: "Trắng Ngọc Trai",
    image: "/bike-sh-white.jpg",
    isNew: true,
    featured: true,
    specs: {
      engine: "150cc eSP+ 4 van, phanh ABS 2 kênh",
      fuel: "Phun xăng điện tử PGM-FI siêu tiết kiệm",
      warranty: "Bảo hành máy 12 tháng tại cửa hàng",
      origin: "Chính chủ Hội An, bao rút hồ sơ sang tên",
    },
    description:
      "Xe tuyển chọn cực kỳ kỹ lưỡng, dàn áo dán keo trong từ lúc mua, máy êm ru, 2 chìa khoá smartkey đầy đủ. Khách xem là ưng ngay.",
  },
  {
    id: "yamaha-nvx-red-2023",
    name: "Yamaha NVX 155 VVA Đỏ Thể Thao",
    brand: "Yamaha",
    category: "scooter",
    year: 2023,
    price: 43500000,
    condition: "98% Đẹp không tì vết",
    plate: "92-D1 556.88 (Quảng Nam)",
    odo: "11.500 km",
    color: "Đỏ Đen Candy",
    image: "/bike-red.jpg",
    isNew: true,
    featured: true,
    specs: {
      engine: "155cc van biến thiên VVA, phanh ABS",
      fuel: "Phun xăng điện tử FI, bình xăng lớn",
      warranty: "Bảo hành máy móc 12 tháng",
      origin: "Hồ sơ gốc cầm tay, công chứng trong ngày",
    },
    description:
      "Dáng xe thể thao mạnh mẽ, tăng tốc cực bốc. Xe bảo dưỡng định kỳ đầy đủ nhớt Motul cao cấp, lốp còn gai gió dày cui.",
  },
  {
    id: "honda-sh-125-red-2022",
    name: "Honda SH 125i CBS Sang Trọng",
    brand: "Honda",
    category: "scooter",
    year: 2022,
    price: 68500000,
    condition: "99% Zin từng con ốc",
    plate: "92-C1 348.92 (Hội An)",
    odo: "9.800 km",
    color: "Đỏ Mận Đậm",
    image: "/hero-banner.jpg",
    isNew: false,
    featured: true,
    specs: {
      engine: "125cc eSP+ êm ái, bốc mượt mà",
      fuel: "Tiết kiệm xăng tối ưu",
      warranty: "Bảo hành 1 năm cửa hàng",
      origin: "Xe chính chủ Hội An",
    },
    description:
      "Màu đỏ đô lịch lãm tôn dáng người lái. Xe người lớn tuổi đi giữ kỹ, chỉ đi phố Hội An, không trầy xước.",
  },
  {
    id: "yamaha-exciter-155-2023",
    name: "Yamaha Exciter 155 VVA Khóa Smartkey",
    brand: "Yamaha",
    category: "manual",
    year: 2023,
    price: 36500000,
    condition: "98% Nguyên bản",
    plate: "92-K1 889.12 (Hội An)",
    odo: "14.000 km",
    color: "Xanh GP Thể Thao",
    image: "/bike-red.jpg",
    isNew: false,
    featured: false,
    specs: {
      engine: "155cc côn tay 6 số VVA mượt mà",
      fuel: "FI điện tử",
      warranty: "Bảo hành máy móc 6 tháng",
      origin: "Biển số Hội An, bao công chứng",
    },
    description:
      "Chiếc xe côn tay quốc dân, côn số nhẹ nhàng, máy móc nguyên zin 100%, pô zin nổ êm ấm.",
  },
  {
    id: "honda-vision-smartkey-2023",
    name: "Honda Vision Bản Cao Cấp Smartkey",
    brand: "Honda",
    category: "scooter",
    year: 2023,
    price: 32000000,
    condition: "99% Như dắt trong hãng ra",
    plate: "92-C1 772.19 (Hội An)",
    odo: "6.500 km",
    color: "Trắng Nâu Lịch Sự",
    image: "/bike-sh-white.jpg",
    isNew: true,
    featured: false,
    specs: {
      engine: "110cc eSP siêu nhẹ nhàng, bền bỉ",
      fuel: "Mức tiêu thụ chỉ 1.8L / 100km",
      warranty: "Bảo hành 12 tháng máy",
      origin: "Chính chủ nữ đi làm văn phòng",
    },
    description:
      "Dòng xe tay ga bán chạy nhất, nhẹ nhàng, cốp rộng, tiết kiệm xăng. Xe rất mới, lốp zin theo xe.",
  },
  {
    id: "piaggio-vespa-sprint-2022",
    name: "Vespa Sprint 125 i-Get ABS Đèn Vuông",
    brand: "Piaggio",
    category: "scooter",
    year: 2022,
    price: 54000000,
    condition: "98% Dàn áo cực kỳ bóng đẹp",
    plate: "92-B1 449.88 (Hội An)",
    odo: "13.200 km",
    color: "Xám Xi Măng Thể Thao",
    image: "/bike-sh-white.jpg",
    isNew: false,
    featured: true,
    specs: {
      engine: "125cc i-Get thế hệ mới êm ái",
      fuel: "Hệ thống phun xăng điện tử",
      warranty: "Bảo hành máy 1 năm",
      origin: "Hồ sơ công chứng sang tên liền",
    },
    description:
      "Phong cách thời trang Ý đẳng cấp. Động cơ iGet êm ru không giật, màu xám xi măng hot trend cực kỳ hút mắt.",
  },
];

export default function ShowroomPage() {
  const { user } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedBrand, setSelectedBrand] = useState("ALL");
  const [selectedTab, setSelectedTab] = useState<"ALL" | "NEW" | "HOT">("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedBike, setSelectedBike] = useState<ShowroomBike | null>(null);
  const [sellModalOpen, setSellModalOpen] = useState(false);
  const [sellForm, setSellForm] = useState({
    bikeName: "",
    year: "",
    phone: "",
    expectedPrice: "",
    note: "",
  });
  const [sellSubmitted, setSellSubmitted] = useState(false);

  const filteredBikes = useMemo(() => {
    return FEATURED_BIKES.filter((bike) => {
      const matchBrand =
        selectedBrand === "ALL" ||
        bike.brand.toLowerCase() === selectedBrand.toLowerCase();
      const matchTab =
        selectedTab === "ALL" ||
        (selectedTab === "NEW" && bike.isNew) ||
        (selectedTab === "HOT" && bike.featured);
      const matchSearch =
        !searchQuery.trim() ||
        bike.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        bike.brand.toLowerCase().includes(searchQuery.toLowerCase()) ||
        bike.plate.toLowerCase().includes(searchQuery.toLowerCase());
      return matchBrand && matchTab && matchSearch;
    });
  }, [selectedBrand, selectedTab, searchQuery]);

  const handleSellSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSellSubmitted(true);
    // Deep link directly to Zalo with pre-filled message
    const msg = `[ĐỊNH GIÁ XE CẦN BÁN]\nTên xe: ${sellForm.bikeName} (Đời: ${sellForm.year})\nSĐT: ${sellForm.phone}\nGiá mong muốn: ${sellForm.expectedPrice || "Thương lượng"}\nGhi chú: ${sellForm.note || "Không có"}`;
    const zaloUrl = `https://zalo.me/0914929292?text=${encodeURIComponent(msg)}`;
    window.open(zaloUrl, "_blank");
  };

  const openZaloConsult = (bike: ShowroomBike) => {
    const msg = `Chào Cửa hàng Cà Rem, tôi muốn hỏi mua chiếc: ${bike.name} - Giá: ${bike.price.toLocaleString("vi-VN")} đ (Biển: ${bike.plate}). Nhờ cửa hàng tư vấn giúp tôi!`;
    const zaloUrl = `https://zalo.me/0914929292?text=${encodeURIComponent(msg)}`;
    window.open(zaloUrl, "_blank");
  };

  return (
    <div className="showroom-root">
      {/* 1. TOP ANNOUNCEMENT & UTILITY BAR */}
      <div className="showroom-top-bar">
        <div className="showroom-container top-bar-content">
          <div className="top-bar-left">
            <span className="live-badge">
              <span className="pulse-dot" /> ĐANG MỞ CỬA: 07:30 - 20:30
            </span>
            <span className="location-text">
              <MapPin size={13} /> 107 Nguyễn Tất Thành, TP. Hội An
            </span>
          </div>
          <div className="top-bar-right">
            <a href="tel:0914929292" className="hotline-link">
              <PhoneCall size={13} /> HOTLINE: <strong>0914.92.92.92</strong>
            </a>
            <span className="divider-vert" />
            <Link to={user ? "/" : "/login"} className="crm-login-pill">
              {user ? (
                <>
                  <Store size={14} /> Vào Quản Trị CRM
                </>
              ) : (
                <>
                  <Lock size={13} /> Đăng nhập CRM
                </>
              )}
            </Link>
          </div>
        </div>
      </div>

      {/* 2. MAIN HEADER NAVIGATION */}
      <header className="showroom-header">
        <div className="showroom-container header-inner">
          <Link to="/showroom" className="showroom-brand">
            <div className="brand-shield-logo">
              <img
                src="/logo.jpg"
                alt="Logo Xe Máy Cà Rem"
                className="brand-shield-img"
              />
              <span className="shield-glow" />
            </div>
            <div className="brand-text-block">
              <span className="brand-title">
                CÀ REM <span className="brand-accent">MOTORCYCLES</span>
              </span>
              <span className="brand-slogan">
                XE MÁY CŨ UY TÍN TẠI HỘI AN
              </span>
            </div>
          </Link>

          {/* Desktop Nav */}
          <nav className="showroom-nav-desktop">
            <a href="#xe-dang-ban" className="nav-item">
              Xe đang bán
            </a>
            <a href="#xe-dang-ban" className="nav-item" onClick={() => setSelectedTab("NEW")}>
              Xe mới về
            </a>
            <a href="#quy-trinh" className="nav-item">
              Thu mua xe
            </a>
            <a href="#quy-trinh" className="nav-item">
              Hỗ trợ trả góp
            </a>
            <a href="#ve-ca-rem" className="nav-item">
              Về Cà Rem
            </a>
            <a href="#lien-he" className="nav-item">
              Liên hệ
            </a>
          </nav>

          {/* Header Action Buttons */}
          <div className="header-actions">
            <button
              type="button"
              className="btn-sell-trigger"
              onClick={() => setSellModalOpen(true)}
            >
              <Tag size={15} />
              <span>Định giá bán xe</span>
            </button>
            <a
              href="https://zalo.me/0914929292"
              target="_blank"
              rel="noreferrer"
              className="btn-zalo-quick"
            >
              <MessageCircle size={15} />
              <span>Chat Zalo</span>
            </a>
            <button
              type="button"
              className="btn-mobile-toggle"
              aria-label="Mở menu"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>

        {/* Mobile Dropdown Menu */}
        {mobileMenuOpen && (
          <div className="showroom-mobile-drawer">
            <div className="mobile-drawer-links">
              <a
                href="#xe-dang-ban"
                className="mobile-link"
                onClick={() => setMobileMenuOpen(false)}
              >
                🏍️ Xe đang bán
              </a>
              <a
                href="#xe-dang-ban"
                className="mobile-link"
                onClick={() => {
                  setSelectedTab("NEW");
                  setMobileMenuOpen(false);
                }}
              >
                ✨ Xe mới về
              </a>
              <button
                type="button"
                className="mobile-link text-left"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setSellModalOpen(true);
                }}
              >
                💰 Bán xe / Định giá xe
              </button>
              <a
                href="#ve-ca-rem"
                className="mobile-link"
                onClick={() => setMobileMenuOpen(false)}
              >
                👤 Giới thiệu Anh Hậu Cà Rem
              </a>
              <a
                href="#quy-trinh"
                className="mobile-link"
                onClick={() => setMobileMenuOpen(false)}
              >
                📋 Quy trình mua bán & Trả góp
              </a>
              <a
                href="#lien-he"
                className="mobile-link"
                onClick={() => setMobileMenuOpen(false)}
              >
                📍 Địa chỉ 107 Nguyễn Tất Thành
              </a>
              <Link
                to={user ? "/" : "/login"}
                className="mobile-link highlight-crm"
                onClick={() => setMobileMenuOpen(false)}
              >
                ⚙️ {user ? "Vào Phần mềm Quản trị CRM" : "Đăng nhập Nhân sự / Chủ xe"}
              </Link>
            </div>
            <div className="mobile-drawer-footer">
              <a href="tel:0914929292" className="mobile-hotline-btn">
                <PhoneCall size={18} /> Gọi Hotline: 0914 929 292
              </a>
            </div>
          </div>
        )}
      </header>

      {/* 3. HERO BANNER SECTION (THEO TEMPLATE ẢNH 1, 3, 4) */}
      <section className="showroom-hero-section">
        <div className="hero-bg-media">
          <img
            src="/hero-banner.jpg"
            alt="Cà Rem Motorcycles Showroom"
            className="hero-bg-img"
          />
          <div className="hero-gradient-overlay" />
          <div className="hero-neon-accent" />
        </div>

        <div className="showroom-container hero-content-wrapper">
          <div className="hero-badge-tag">
            <span className="badge-shield-icon">🛡️</span>
            <span>MUA BÁN XE MÁY CŨ UY TÍN TẠI HỘI AN</span>
          </div>

          <h1 className="hero-main-title">
            CÀ REM <span className="title-highlight">MOTORCYCLES</span>
          </h1>

          <p className="hero-slogan">
            Xe đẹp. Giá rõ ràng. Mua bán nhanh gọn.
          </p>

          <p className="hero-description">
            Tuyển chọn khắt khe từng chiếc xe máy cũ chất lượng cao tại Hội An.
            Minh bạch máy móc nguyên bản, hồ sơ pháp lý chuẩn chỉnh, hỗ trợ sang
            tên trọn gói và trả góp lãi suất cực thấp.
          </p>

          <div className="hero-cta-group">
            <a href="#xe-dang-ban" className="btn-hero-primary">
              <Bike size={18} />
              <span>Xem xe đang bán</span>
            </a>
            <button
              type="button"
              className="btn-hero-secondary"
              onClick={() => setSellModalOpen(true)}
            >
              <Tag size={18} />
              <span>Định giá xe cần bán</span>
            </button>
            <a
              href="https://zalo.me/0914929292"
              target="_blank"
              rel="noreferrer"
              className="btn-hero-zalo"
            >
              <MessageCircle size={18} />
              <span>Zalo: 0914.92.92.92</span>
            </a>
          </div>

          {/* Quick Trust Highlights */}
          <div className="hero-trust-bar">
            <div className="trust-item">
              <ShieldCheck size={18} className="trust-icon" />
              <span>Máy móc nguyên zin 100%</span>
            </div>
            <div className="trust-item">
              <CheckCircle2 size={18} className="trust-icon" />
              <span>Pháp lý chuẩn - Bao sang tên</span>
            </div>
            <div className="trust-item">
              <CreditCard size={18} className="trust-icon" />
              <span>Hỗ trợ trả góp duyệt nhanh 15 phút</span>
            </div>
            <div className="trust-item">
              <Handshake size={18} className="trust-icon" />
              <span>Thu mua tận nơi giá cao nhất</span>
            </div>
          </div>
        </div>
      </section>

      {/* 4. 4 THẺ THAO TÁC NHANH VIỀN ĐỎ NEON (CHUẨN THEO ẢNH 1 & ẢNH 2) */}
      <section className="showroom-quick-actions-section">
        <div className="showroom-container">
          <div className="quick-action-neon-grid">
            <a href="#xe-dang-ban" className="neon-card" onClick={() => setSelectedTab("ALL")}>
              <div className="neon-card-icon">
                <Bike size={32} />
              </div>
              <h3 className="neon-card-title">Xe đang bán</h3>
              <p className="neon-card-desc">
                Kho xe tuyển chọn phong phú các dòng Honda, Yamaha, Vespa sẵn sàng tại cửa hàng.
              </p>
              <span className="neon-card-link">
                Xem kho xe <ChevronRight size={15} />
              </span>
            </a>

            <a href="#xe-dang-ban" className="neon-card" onClick={() => setSelectedTab("NEW")}>
              <div className="neon-card-icon">
                <Sparkles size={32} />
              </div>
              <h3 className="neon-card-title">Xe mới về</h3>
              <p className="neon-card-desc">
                Cập nhật liên tục các đời xe SH, NVX, Vision lướt vừa cập bến Hội An hôm nay.
              </p>
              <span className="neon-card-link">
                Xem xe mới về <ChevronRight size={15} />
              </span>
            </a>

            <div className="neon-card" onClick={() => setSellModalOpen(true)}>
              <div className="neon-card-icon">
                <Handshake size={32} />
              </div>
              <h3 className="neon-card-title">Hỗ trợ trả góp</h3>
              <p className="neon-card-desc">
                Liên kết các ngân hàng uy tín. Chỉ cần CCCD, không chứng minh thu nhập, nhận xe ngay.
              </p>
              <span className="neon-card-link">
                Tư vấn trả góp <ChevronRight size={15} />
              </span>
            </div>

            <div className="neon-card highlight" onClick={() => setSellModalOpen(true)}>
              <div className="neon-card-icon">
                <Store size={32} />
              </div>
              <h3 className="neon-card-title">Thu mua xe cũ</h3>
              <p className="neon-card-desc">
                Định giá công tâm, tiền mặt liền tay trong 10 phút. Hỗ trợ đến tận nơi tại Hội An.
              </p>
              <span className="neon-card-link">
                Bán xe ngay <ChevronRight size={15} />
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 5. SHOWROOM INVENTORY (XE ĐANG CÓ TẠI CÀ REM) */}
      <section id="xe-dang-ban" className="showroom-inventory-section">
        <div className="showroom-container">
          <div className="section-head-center">
            <span className="section-sub-tag">DANH MỤC XE TUYỂN CHỌN</span>
            <h2 className="section-title-large">
              Xe đang có tại <span className="text-red">Cà Rem</span>
            </h2>
            <p className="section-subtitle">
              Tất cả xe đều được kỹ thuật viên kiểm định 28 hạng mục, vệ sinh bảo
              dưỡng kỹ càng trước khi bàn giao chìa khóa.
            </p>
          </div>

          {/* Filtering & Search Bar */}
          <div className="showroom-filter-bar">
            {/* Tabs */}
            <div className="inventory-tabs">
              <button
                type="button"
                className={`inv-tab ${selectedTab === "ALL" ? "active" : ""}`}
                onClick={() => setSelectedTab("ALL")}
              >
                Tất cả xe ({FEATURED_BIKES.length})
              </button>
              <button
                type="button"
                className={`inv-tab ${selectedTab === "NEW" ? "active" : ""}`}
                onClick={() => setSelectedTab("NEW")}
              >
                🔥 Xe mới về
              </button>
              <button
                type="button"
                className={`inv-tab ${selectedTab === "HOT" ? "active" : ""}`}
                onClick={() => setSelectedTab("HOT")}
              >
                ⭐ Xe nổi bật
              </button>
            </div>

            {/* Brand Chips */}
            <div className="brand-chips-row">
              {["ALL", "Honda", "Yamaha", "Piaggio"].map((brand) => (
                <button
                  key={brand}
                  type="button"
                  className={`brand-chip ${selectedBrand === brand ? "active" : ""}`}
                  onClick={() => setSelectedBrand(brand)}
                >
                  {brand === "ALL" ? "Tất cả hãng" : brand}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="showroom-search-box">
              <Search size={16} className="search-icon" />
              <input
                type="text"
                placeholder="Tìm xe: SH, NVX, Vision, Exciter..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="clear-search-btn"
                  onClick={() => setSearchQuery("")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Bike Cards Grid */}
          <div className="showroom-bike-grid">
            {filteredBikes.map((bike) => (
              <div key={bike.id} className="bike-card-neon">
                {/* Image Container */}
                <div
                  className="bike-card-image-wrap"
                  onClick={() => setSelectedBike(bike)}
                >
                  <img
                    src={bike.image}
                    alt={bike.name}
                    className="bike-card-img"
                    loading="lazy"
                  />
                  <div className="bike-badges-floating">
                    {bike.isNew && (
                      <span className="badge-pill badge-new">MỚI VỀ</span>
                    )}
                    {bike.featured && (
                      <span className="badge-pill badge-hot">HOT</span>
                    )}
                  </div>
                  <span className="badge-plate">{bike.plate}</span>
                  <div className="bike-image-hover-overlay">
                    <span>Xem chi tiết thông số →</span>
                  </div>
                </div>

                {/* Content */}
                <div className="bike-card-body">
                  <div className="bike-brand-year">
                    <span className="bike-brand">{bike.brand}</span>
                    <span className="bike-year">Đời {bike.year}</span>
                    <span className="bike-odo">• {bike.odo}</span>
                  </div>

                  <h3
                    className="bike-card-title"
                    onClick={() => setSelectedBike(bike)}
                  >
                    {bike.name}
                  </h3>

                  <p className="bike-condition-tag">
                    <CheckCircle2 size={13} /> {bike.condition}
                  </p>

                  <div className="bike-price-row">
                    <div className="price-block">
                      <span className="price-label">Giá niêm yết:</span>
                      <strong className="price-amount">
                        {bike.price.toLocaleString("vi-VN")} đ
                      </strong>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="bike-actions-row">
                    <button
                      type="button"
                      className="btn-card-detail"
                      onClick={() => setSelectedBike(bike)}
                    >
                      Chi tiết
                    </button>
                    <button
                      type="button"
                      className="btn-card-zalo"
                      onClick={() => openZaloConsult(bike)}
                      title="Nhắn Zalo tư vấn xe này"
                    >
                      <MessageCircle size={15} />
                      <span>Hỏi Zalo</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {filteredBikes.length === 0 && (
            <div className="showroom-empty-state">
              <Bike size={48} className="empty-icon" />
              <h3>Không tìm thấy chiếc xe phù hợp</h3>
              <p>
                Cửa hàng liên tục cập nhật xe mới hàng ngày. Bạn hãy nhắn tin
                Zalo để Cà Rem tìm xe đúng yêu cầu cho bạn nhé!
              </p>
              <button
                type="button"
                className="btn-hero-primary"
                onClick={() => {
                  setSelectedBrand("ALL");
                  setSelectedTab("ALL");
                  setSearchQuery("");
                }}
              >
                Xem tất cả xe
              </button>
            </div>
          )}
        </div>
      </section>

      {/* 6. VỀ CÀ REM (CHUYỆN ÔNG CHỦ ANH HẬU - CHUẨN THEO ẢNH 1 & ẢNH 3) */}
      <section id="ve-ca-rem" className="showroom-about-section">
        <div className="showroom-container">
          <div className="about-carem-card">
            <div className="about-media-col">
              <div className="owner-avatar-frame">
                <img
                  src="/avtcarem.jpg"
                  alt="Anh Hậu - Chủ Cửa Hàng Xe Máy Cà Rem"
                  className="owner-avatar-img"
                />
                <span className="owner-status-badge">
                  <Star size={14} className="star-icon" /> CHỦ CỬA HÀNG CÀ REM
                </span>
              </div>
              <div className="owner-contact-pill">
                <strong>Hậu · Cà Rem Hội An</strong>
                <a href="tel:0914929292">📞 0914.92.92.92</a>
              </div>
            </div>

            <div className="about-text-col">
              <span className="eyebrow-red">UY TÍN TẠI HỘI AN HƠN 5 NĂM</span>
              <h2 className="about-title">
                Về Cửa Hàng <span className="text-red">Xe Máy Cà Rem</span>
              </h2>

              <blockquote className="owner-quote">
                “Xin chào: Tôi là Hậu - chủ cửa hàng Xe Máy Cà Rem. Với kinh
                nghiệm hơn 5 năm trong nghề xe máy cũ tại Hội An, tôi cam kết
                mang đến cho bà con, anh chị em những chiếc xe máy tuyển chọn
                chất lượng nhất, chuẩn zin từng chi tiết với giá cả thật tâm và
                hợp lý nhất.”
              </blockquote>

              <div className="commitments-grid">
                <div className="commit-box">
                  <span className="commit-icon">💎</span>
                  <div>
                    <strong>Chất lượng thật 100%</strong>
                    <p>
                      Tuyển chọn xe kỹ, máy móc zin, không bán xe tai nạn, thủy
                      kích hoặc tua đồng hồ.
                    </p>
                  </div>
                </div>

                <div className="commit-box">
                  <span className="commit-icon">📜</span>
                  <div>
                    <strong>Pháp lý chuẩn chỉ</strong>
                    <p>
                      Đầy đủ giấy tờ hợp lệ, nguồn gốc rõ ràng, bao rút gốc và
                      hỗ trợ sang tên nhanh chóng.
                    </p>
                  </div>
                </div>

                <div className="commit-box">
                  <span className="commit-icon">🛠️</span>
                  <div>
                    <strong>Bảo hành chu đáo</strong>
                    <p>
                      Bảo hành động cơ từ 6 đến 12 tháng. Miễn phí bảo dưỡng, thay
                      nhớt trước khi giao xe.
                    </p>
                  </div>
                </div>

                <div className="commit-box">
                  <span className="commit-icon">🔄</span>
                  <div>
                    <strong>Bao quay đầu linh hoạt</strong>
                    <p>
                      Hỗ trợ đổi xe, lên đời hoặc thu mua lại với mức khấu hao cực
                      kỳ ưu đãi cho khách cũ.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 7. QUY TRÌNH BÁN XE / THU MUA XE (THEO ẢNH 3 & ẢNH 4) */}
      <section id="quy-trinh" className="showroom-process-section">
        <div className="showroom-container">
          <div className="process-header">
            <span className="eyebrow-red">ĐỊNH GIÁ NHANH TRONG 5 PHÚT</span>
            <h2 className="section-title-large">
              Bạn Muốn Bán Xe? <span className="text-red">Cà Rem Thu Mua Giá Cao</span>
            </h2>
            <p className="section-subtitle">
              Chuyên thu mua và ký gửi các dòng xe máy: SH, Vespa, Air Blade,
              Exciter, Winner, Vision... Tiền mặt nhận liền tay tại Hội An.
            </p>
          </div>

          <div className="process-steps-row">
            <div className="process-step-item">
              <span className="step-number">01</span>
              <h4>Gửi thông tin xe</h4>
              <p>Chụp ảnh xe và gửi đăng ký xe qua Zalo 0914.92.92.92 hoặc form web.</p>
            </div>
            <div className="step-arrow">→</div>

            <div className="process-step-item">
              <span className="step-number">02</span>
              <h4>Kiểm tra & Định giá</h4>
              <p>Cà Rem kiểm tra tình trạng máy móc, báo giá công khai đúng giá trị thực.</p>
            </div>
            <div className="step-arrow">→</div>

            <div className="process-step-item">
              <span className="step-number">03</span>
              <h4>Báo giá chuẩn xác</h4>
              <p>Cam kết giá thu mua cạnh tranh, không ép giá, hỗ trợ đến tận nhà xem xe.</p>
            </div>
            <div className="step-arrow">→</div>

            <div className="process-step-item highlight-step">
              <span className="step-number">04</span>
              <h4>Hoàn tất giao dịch</h4>
              <p>Làm thủ tục công chứng nhanh gọn và thanh toán tiền mặt hoặc chuyển khoản ngay.</p>
            </div>
          </div>

          <div className="process-cta-center">
            <button
              type="button"
              className="btn-hero-primary big-btn"
              onClick={() => setSellModalOpen(true)}
            >
              <Tag size={20} />
              <span>Gửi thông tin xe cần bán ngay</span>
            </button>
            <span className="hotline-subtext">
              Hoặc gọi trực tiếp: <strong>0914 929 292</strong> (Anh Hậu Cà Rem)
            </span>
          </div>
        </div>
      </section>

      {/* 8. CÀ REM NGOÀI ĐỜI (ALBUM BÀN GIAO THỰC TẾ THEO ẢNH 3 & ẢNH 4) */}
      <section className="showroom-gallery-section">
        <div className="showroom-container">
          <div className="section-head-center">
            <span className="section-sub-tag">HÌNH ẢNH THỰC TẾ</span>
            <h2 className="section-title-large">
              Cà Rem <span className="text-red">Ngoài Đời</span>
            </h2>
            <p className="section-subtitle">
              Niềm vui của khách hàng khi nhận bàn giao những chiếc xe ưng ý là
              động lực lớn nhất của Cà Rem mỗi ngày.
            </p>
          </div>

          <div className="gallery-masonry-grid">
            <div className="gallery-card featured-img">
              <img
                src="/carem-handover.jpg"
                alt="Bàn giao xe máy cho khách hàng tại Cà Rem"
                className="gallery-img"
              />
              <div className="gallery-caption">
                <strong>Bàn giao xe tận tay khách hàng</strong>
                <span>Hồ sơ giấy tờ trao tay, kiểm tra xe kỹ càng</span>
              </div>
            </div>

            <div className="gallery-card">
              <img
                src="/bike-sh-white.jpg"
                alt="Xe Honda SH tại showroom Cà Rem Hội An"
                className="gallery-img"
              />
              <div className="gallery-caption">
                <strong>Dàn xe tuyển chọn bóng loáng</strong>
                <span>100% xe trưng bày tại 107 Nguyễn Tất Thành</span>
              </div>
            </div>

            <div className="gallery-card">
              <img
                src="/bike-red.jpg"
                alt="Dòng xe thể thao tại Cà Rem"
                className="gallery-img"
              />
              <div className="gallery-caption">
                <strong>Bảo dưỡng máy móc định kỳ</strong>
                <span>Xe luôn sẵn sàng lăn bánh cùng chủ nhân mới</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 9. THÔNG TIN LIÊN HỆ & BẢN ĐỒ HỘI AN */}
      <section id="lien-he" className="showroom-contact-section">
        <div className="showroom-container">
          <div className="contact-card-dual">
            {/* Contact Details */}
            <div className="contact-info-col">
              <span className="eyebrow-red">ĐÓN TIẾP ANH CHỊ EM TẬN TÌNH</span>
              <h2 className="contact-title">
                Liên hệ <span className="text-red">Cà Rem</span>
              </h2>

              <ul className="contact-list">
                <li className="contact-item">
                  <div className="icon-circle">
                    <MapPin size={20} />
                  </div>
                  <div>
                    <strong>Địa chỉ cửa hàng:</strong>
                    <p>107 Nguyễn Tất Thành, Phường Cẩm Phô, TP. Hội An, Quảng Nam</p>
                  </div>
                </li>

                <li className="contact-item">
                  <div className="icon-circle">
                    <PhoneCall size={20} />
                  </div>
                  <div>
                    <strong>Hotline trực tiếp:</strong>
                    <p>
                      <a href="tel:0914929292" className="phone-bold">
                        0914.92.92.92
                      </a>{" "}
                      (Hậu Cà Rem)
                    </p>
                  </div>
                </li>

                <li className="contact-item">
                  <div className="icon-circle">
                    <MessageCircle size={20} />
                  </div>
                  <div>
                    <strong>Zalo tư vấn 24/7:</strong>
                    <p>
                      <a
                        href="https://zalo.me/0914929292"
                        target="_blank"
                        rel="noreferrer"
                        className="link-zalo"
                      >
                        0914.92.92.92 (Bấm vào đây để chat)
                      </a>
                    </p>
                  </div>
                </li>

                <li className="contact-item">
                  <div className="icon-circle">
                    <Clock size={20} />
                  </div>
                  <div>
                    <strong>Giờ mở cửa đón khách:</strong>
                    <p>07:30 – 20:30 (Mở cửa tất cả các ngày trong tuần)</p>
                  </div>
                </li>
              </ul>

              <div className="social-pills-row">
                <a
                  href="https://www.facebook.com/tim.lai.52055"
                  target="_blank"
                  rel="noreferrer"
                  className="social-btn facebook"
                >
                  Facebook Cà Rem
                </a>
                <a
                  href="https://zalo.me/0914929292"
                  target="_blank"
                  rel="noreferrer"
                  className="social-btn zalo"
                >
                  Nhắn Zalo
                </a>
                <a href="tel:0914929292" className="social-btn call">
                  Gọi Ngay
                </a>
              </div>
            </div>

            {/* Map Frame */}
            <div className="contact-map-col">
              <div className="map-wrapper-card">
                <iframe
                  title="Bản đồ Cửa Hàng Xe Máy Cà Rem Hội An"
                  src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3838.56364188764!2d108.32422777598125!3d15.882191984768393!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x31420dd676a6cf9b%3A0xe54e63fc486111f2!2zMTA3IE5ndXnhu4VuIFThuqV0IFRow6BuaCwgQ-G6qW0gUGjDtCwgSOG7mWkgQW4sIFF14bqjbmcgTmFt!5e0!3m2!1svi!2s!4v1711200000000!5m2!1svi!2s"
                  width="100%"
                  height="100%"
                  style={{ border: 0 }}
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
                <div className="map-badge">
                  <MapPin size={16} /> 107 Nguyễn Tất Thành, Hội An
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 10. FOOTER */}
      <footer className="showroom-footer">
        <div className="showroom-container footer-content">
          <div className="footer-top-row">
            <div className="footer-brand-info">
              <div className="footer-logo">
                <img
                  src="/logo.jpg"
                  alt="Cà Rem Motorcycles"
                  className="footer-logo-img"
                />
                <span>CÀ REM MOTORCYCLES</span>
              </div>
              <p className="footer-motto">
                Chuyên mua bán, ký gửi xe máy tuyển chọn uy tín tại Hội An.
                Định giá chuẩn xác, mua bán nhanh gọn, đồng hành bền lâu.
              </p>
            </div>

            <div className="footer-links-col">
              <h4>Dịch vụ</h4>
              <ul>
                <li><a href="#xe-dang-ban">Xe đang bán</a></li>
                <li><a href="#xe-dang-ban" onClick={() => setSelectedTab("NEW")}>Xe mới về</a></li>
                <li><button type="button" onClick={() => setSellModalOpen(true)}>Định giá xe</button></li>
                <li><a href="#quy-trinh">Hỗ trợ trả góp</a></li>
              </ul>
            </div>

            <div className="footer-links-col">
              <h4>Liên kết nhanh</h4>
              <ul>
                <li><a href="#ve-ca-rem">Về Cà Rem</a></li>
                <li><a href="#lien-he">Bản đồ cửa hàng</a></li>
                <li><a href="https://zalo.me/0914929292">Zalo tư vấn</a></li>
                <li>
                  <Link to={user ? "/" : "/login"} className="text-red">
                    Đăng nhập Quản trị CRM
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="footer-bottom-bar">
            <span>© 2026 Cửa Hàng Xe Máy Cà Rem · 107 Nguyễn Tất Thành, Hội An. All rights reserved.</span>
            <span className="power-by">Hệ thống vận hành Cà Rem</span>
          </div>
        </div>
      </footer>

      {/* MODAL: CHI TIẾT XE */}
      {selectedBike && (
        <div
          className="showroom-modal-backdrop"
          onClick={() => setSelectedBike(null)}
        >
          <div
            className="showroom-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close-btn"
              onClick={() => setSelectedBike(null)}
            >
              <X size={20} />
            </button>

            <div className="modal-bike-layout">
              <div className="modal-img-col">
                <img
                  src={selectedBike.image}
                  alt={selectedBike.name}
                  className="modal-bike-img"
                />
                <div className="modal-img-caption">
                  <span className="badge-plate">{selectedBike.plate}</span>
                  <span className="badge-condition">{selectedBike.condition}</span>
                </div>
              </div>

              <div className="modal-info-col">
                <div className="modal-badge-row">
                  <span className="modal-brand-tag">{selectedBike.brand}</span>
                  <span className="modal-year-tag">Đời {selectedBike.year}</span>
                </div>

                <h2 className="modal-bike-title">{selectedBike.name}</h2>

                <div className="modal-price-box">
                  <span className="label">Giá bán công khai:</span>
                  <strong className="val">
                    {selectedBike.price.toLocaleString("vi-VN")} đ
                  </strong>
                </div>

                <p className="modal-bike-desc">{selectedBike.description}</p>

                <div className="modal-specs-list">
                  <div className="spec-row">
                    <span className="k">Động cơ:</span>
                    <span className="v">{selectedBike.specs.engine}</span>
                  </div>
                  <div className="spec-row">
                    <span className="k">Màu sơn:</span>
                    <span className="v">{selectedBike.color}</span>
                  </div>
                  <div className="spec-row">
                    <span className="k">Đã lăn bánh:</span>
                    <span className="v">{selectedBike.odo}</span>
                  </div>
                  <div className="spec-row">
                    <span className="k">Bảo hành:</span>
                    <span className="v text-highlight">
                      {selectedBike.specs.warranty}
                    </span>
                  </div>
                  <div className="spec-row">
                    <span className="k">Giấy tờ & Pháp lý:</span>
                    <span className="v">{selectedBike.specs.origin}</span>
                  </div>
                </div>

                <div className="modal-action-buttons">
                  <button
                    type="button"
                    className="btn-modal-zalo"
                    onClick={() => openZaloConsult(selectedBike)}
                  >
                    <MessageCircle size={18} />
                    <span>Nhắn Zalo hỏi giá tốt xe này</span>
                  </button>
                  <a
                    href="tel:0914929292"
                    className="btn-modal-call"
                  >
                    <PhoneCall size={18} />
                    <span>Gọi 0914 929 292</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: ĐỊNH GIÁ & BÁN XE NHANH */}
      {sellModalOpen && (
        <div
          className="showroom-modal-backdrop"
          onClick={() => {
            setSellModalOpen(false);
            setSellSubmitted(false);
          }}
        >
          <div
            className="showroom-modal-card sell-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close-btn"
              onClick={() => {
                setSellModalOpen(false);
                setSellSubmitted(false);
              }}
            >
              <X size={20} />
            </button>

            <div className="sell-modal-content">
              <span className="eyebrow-red">ĐỊNH GIÁ XE TẬN TÂM</span>
              <h2>Gửi Thông Tin Xe Cần Bán</h2>
              <p className="sub">
                Cà Rem cam kết báo giá nhanh trong 5 phút, mua giá cao nhất thị
                trường Hội An, thanh toán tiền mặt liền tay.
              </p>

              {sellSubmitted ? (
                <div className="sell-success-box">
                  <CheckCircle2 size={42} className="success-icon" />
                  <h3>Đã mở kết nối Zalo với Anh Hậu Cà Rem!</h3>
                  <p>
                    Bạn có thể gửi thêm ảnh xe và ảnh đăng ký xe qua Zalo để
                    nhận định giá chính xác và nhanh nhất nhé!
                  </p>
                  <a
                    href="https://zalo.me/0914929292"
                    target="_blank"
                    rel="noreferrer"
                    className="btn-hero-primary"
                  >
                    Tiếp tục chat Zalo (0914.92.92.92)
                  </a>
                </div>
              ) : (
                <form onSubmit={handleSellSubmit} className="sell-form-stack">
                  <div className="form-group">
                    <label>Tên dòng xe cần bán *</label>
                    <input
                      type="text"
                      required
                      placeholder="Ví dụ: Honda SH 150i, Vision, Exciter 155..."
                      value={sellForm.bikeName}
                      onChange={(e) =>
                        setSellForm({ ...sellForm, bikeName: e.target.value })
                      }
                    />
                  </div>

                  <div className="form-row-2">
                    <div className="form-group">
                      <label>Đời xe / Năm đăng ký</label>
                      <input
                        type="text"
                        placeholder="Ví dụ: 2021 hoặc 2023"
                        value={sellForm.year}
                        onChange={(e) =>
                          setSellForm({ ...sellForm, year: e.target.value })
                        }
                      />
                    </div>
                    <div className="form-group">
                      <label>Số điện thoại / Zalo của bạn *</label>
                      <input
                        type="tel"
                        required
                        placeholder="0914 xxx xxx"
                        value={sellForm.phone}
                        onChange={(e) =>
                          setSellForm({ ...sellForm, phone: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Giá bạn mong muốn (VNĐ)</label>
                    <input
                      type="text"
                      placeholder="Ví dụ: 45 triệu (hoặc để trống)"
                      value={sellForm.expectedPrice}
                      onChange={(e) =>
                        setSellForm({
                          ...sellForm,
                          expectedPrice: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div className="form-group">
                    <label>Tình trạng xe / Ghi chú thêm</label>
                    <textarea
                      rows={2}
                      placeholder="Xe biển số Hội An, máy móc nguyên zin, có trầy xước nhẹ..."
                      value={sellForm.note}
                      onChange={(e) =>
                        setSellForm({ ...sellForm, note: e.target.value })
                      }
                    />
                  </div>

                  <button type="submit" className="btn-hero-primary full-width">
                    <Tag size={18} />
                    <span>Gửi thông tin định giá qua Zalo ngay</span>
                  </button>

                  <p className="privacy-note">
                    🔒 Thông tin của bạn được bảo mật tuyệt đối, chỉ dùng để Cà
                    Rém liên hệ báo giá.
                  </p>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
