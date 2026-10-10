/**
 * Danh mục chuẩn các ngân hàng tại Việt Nam theo chuẩn NAPAS / VietQR
 * Nguồn: Cổng thanh toán quốc gia Napas & VietQR.
 */

export type BankInfo = {
  bin: string;
  code: string;
  shortName: string;
  name: string;
  isPopular?: boolean;
};

export const VIETNAM_BANKS: BankInfo[] = [
  // Nhóm ngân hàng phổ biến hàng đầu
  { bin: "970422", code: "MB", shortName: "MBBank", name: "Ngân hàng TMCP Quân đội", isPopular: true },
  { bin: "970436", code: "VCB", shortName: "Vietcombank", name: "Ngân hàng TMCP Ngoại thương Việt Nam", isPopular: true },
  { bin: "970415", code: "CTG", shortName: "VietinBank", name: "Ngân hàng TMCP Công thương Việt Nam", isPopular: true },
  { bin: "970418", code: "BIDV", shortName: "BIDV", name: "Ngân hàng TMCP Đầu tư và Phát triển Việt Nam", isPopular: true },
  { bin: "970407", code: "TCB", shortName: "Techcombank", name: "Ngân hàng TMCP Kỹ thương Việt Nam", isPopular: true },
  { bin: "970416", code: "ACB", shortName: "ACB", name: "Ngân hàng TMCP Á Châu", isPopular: true },
  { bin: "970432", code: "VPB", shortName: "VPBank", name: "Ngân hàng TMCP Việt Nam Thịnh Vượng", isPopular: true },
  { bin: "970423", code: "TPB", shortName: "TPBank", name: "Ngân hàng TMCP Tiên Phong", isPopular: true },
  { bin: "970405", code: "VBA", shortName: "Agribank", name: "Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam", isPopular: true },
  { bin: "970403", code: "STB", shortName: "Sacombank", name: "Ngân hàng TMCP Sài Gòn Thương Tín", isPopular: true },
  { bin: "970437", code: "HDB", shortName: "HDBank", name: "Ngân hàng TMCP Phát triển TP.HCM", isPopular: true },
  { bin: "970441", code: "VIB", shortName: "VIB", name: "Ngân hàng TMCP Quốc tế Việt Nam", isPopular: true },
  { bin: "970443", code: "SHB", shortName: "SHB", name: "Ngân hàng TMCP Sài Gòn - Hà Nội", isPopular: true },
  { bin: "970426", code: "MSB", shortName: "MSB", name: "Ngân hàng TMCP Hàng Hải Việt Nam", isPopular: true },
  { bin: "970449", code: "LPB", shortName: "LPBank", name: "Ngân hàng TMCP Lộc Phát Việt Nam", isPopular: true },
  { bin: "970448", code: "OCB", shortName: "OCB", name: "Ngân hàng TMCP Phương Đông", isPopular: true },
  { bin: "970440", code: "SSB", shortName: "SeABank", name: "Ngân hàng TMCP Đông Nam Á", isPopular: true },
  { bin: "970431", code: "EIB", shortName: "Eximbank", name: "Ngân hàng TMCP Xuất Nhập Khẩu Việt Nam", isPopular: true },

  // Nhóm ngân hàng khác
  { bin: "970428", code: "NAB", shortName: "Nam A Bank", name: "Ngân hàng TMCP Nam Á" },
  { bin: "970409", code: "BAB", shortName: "Bac A Bank", name: "Ngân hàng TMCP Bắc Á" },
  { bin: "970452", code: "KLB", shortName: "Kienlongbank", name: "Ngân hàng TMCP Kiên Long" },
  { bin: "970454", code: "BVB", shortName: "BVBank", name: "Ngân hàng TMCP Bản Việt" },
  { bin: "970412", code: "PVCB", shortName: "PVcomBank", name: "Ngân hàng TMCP Đại Chúng Việt Nam" },
  { bin: "970427", code: "VAB", shortName: "VietABank", name: "Ngân hàng TMCP Việt Á" },
  { bin: "970438", code: "BVBK", shortName: "BaoViet Bank", name: "Ngân hàng TMCP Bảo Việt" },
  { bin: "970400", code: "SGB", shortName: "Saigonbank", name: "Ngân hàng TMCP Sài Gòn Công Thương" },
  { bin: "970430", code: "PGB", shortName: "PGBank", name: "Ngân hàng TMCP Thịnh vượng và Phát triển" },
  { bin: "970424", code: "SHBVN", shortName: "Shinhan Bank", name: "Ngân hàng TNHH MTV Shinhan Việt Nam" },
  { bin: "970457", code: "WVB", shortName: "Woori Bank", name: "Ngân hàng TNHH MTV Woori Việt Nam" },
  { bin: "970439", code: "PBVN", shortName: "Public Bank", name: "Ngân hàng TNHH MTV Public Việt Nam" },
  { bin: "422589", code: "CIMB", shortName: "CIMB", name: "Ngân hàng TNHH MTV CIMB Việt Nam" },
  { bin: "970458", code: "UOB", shortName: "UOB", name: "Ngân hàng United Overseas Bank Việt Nam" },
  { bin: "546034", code: "CAKE", shortName: "CAKE by VPBank", name: "Ngân hàng số CAKE by VPBank" },
  { bin: "963388", code: "TIMO", shortName: "Timo by BVBank", name: "Ngân hàng số Timo by BVBank" },
  { bin: "971005", code: "VTLMONEY", shortName: "Viettel Money", name: "Tổng Công ty Dịch vụ Số Viettel" },
  { bin: "971011", code: "VNPTMONEY", shortName: "VNPT Money", name: "Tập đoàn Bưu chính Viễn thông Việt Nam" },
];

export function getBankByBin(bin: string): BankInfo | undefined {
  const clean = bin.trim();
  return VIETNAM_BANKS.find((b) => b.bin === clean);
}

export function searchBanks(query: string): BankInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return VIETNAM_BANKS;
  return VIETNAM_BANKS.filter(
    (b) =>
      b.bin.includes(q) ||
      b.shortName.toLowerCase().includes(q) ||
      b.code.toLowerCase().includes(q) ||
      b.name.toLowerCase().includes(q),
  );
}
