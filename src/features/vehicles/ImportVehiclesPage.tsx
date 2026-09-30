import { useState, useRef, type ChangeEvent, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  RotateCcw,
  Upload,
} from "lucide-react";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import { canFinance, canOperate } from "@/lib/permissions";
import {
  downloadVehicleImportTemplate,
  parseVehiclesCsv,
  validateImportRows,
} from "@/lib/csv";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { ImportVehicleRow } from "@/types";

type ValidatedRow = {
  index: number;
  data: ImportVehicleRow;
  raw: Record<string, string>;
  isValid: boolean;
  isDuplicate: boolean;
  errors: string[];
};

export function ImportVehiclesPage() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<"upload" | "preview" | "success">("upload");
  const [fileName, setFileName] = useState("");
  const [parsedRows, setParsedRows] = useState<ValidatedRow[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [fileError, setFileError] = useState<unknown>(null);
  const processing = useRef(false);
  const [importResult, setImportResult] = useState<{ count: number } | null>(
    null,
  );

  const importMutation = useMutation({
    mutationFn: (vehicles: ImportVehicleRow[]) =>
      api.call<{ imported_count: number; vehicle_ids: string[] }>(
        "import_vehicles",
        {
          p_vehicles: vehicles,
        },
      ),
    onSuccess: async (res) => {
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["acquisitions"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      setImportResult({ count: res.imported_count });
      setStep("success");
    },
  });

  if (!canOperate(profile)) {
    return (
      <EmptyState
        title="Quyền truy cập bị giới hạn"
        description="Chỉ nhân viên và quản lý mới có quyền nhập xe vào kho."
      />
    );
  }

  const handleFileProcess = async (file: File) => {
    if (processing.current || importMutation.isPending) return;
    setFileError(null);
    if (
      !file.name.toLowerCase().endsWith(".csv") ||
      file.size > 2 * 1024 * 1024
    ) {
      setFileError(
        new Error("Chọn file CSV tối đa 2 MB. Có thể xuất CSV UTF-8 từ Excel."),
      );
      return;
    }
    processing.current = true;
    setFileName(file.name);
    setIsValidating(true);

    try {
      const text = await file.text();
      const { rawRows } = parseVehiclesCsv(text);

      if (rawRows.length === 0) {
        throw new Error("File không có dữ liệu xe.");
      }

      const locallyValidated = validateImportRows(rawRows, canFinance(profile));

      // 2. Database duplicate check via validate_import_vehicles RPC
      const payloadToCheck = locallyValidated.map((row) => row.data);

      if (payloadToCheck.length > 0) {
        const dbValidation = await api.call<{
          duplicates: Array<{
            index: number;
            field: string;
            value: string;
            message: string;
          }>;
          errors: Array<{ index: number; message: string }>;
        }>("validate_import_vehicles", {
          p_vehicles: payloadToCheck,
        });

        if (dbValidation.duplicates?.length || dbValidation.errors?.length) {
          const dupMap = new Map<number, string[]>();
          for (const d of [
            ...(dbValidation.duplicates || []),
            ...(dbValidation.errors || []),
          ]) {
            const list = dupMap.get(d.index) || [];
            list.push(d.message);
            dupMap.set(d.index, list);
          }

          locallyValidated.forEach((row, i) => {
            if (dupMap.has(i)) {
              row.isDuplicate =
                row.isDuplicate ||
                !!dbValidation.duplicates?.some(
                  (duplicate) => duplicate.index === i,
                );
              row.isValid = false;
              row.errors.push(...dupMap.get(i)!);
            }
          });
        }
      }

      setParsedRows(locallyValidated);
      setStep("preview");
    } catch (err: unknown) {
      setFileError(err);
    } finally {
      setIsValidating(false);
      processing.current = false;
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files?.[0]) {
      void handleFileProcess(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      void handleFileProcess(e.target.files[0]);
    }
  };

  const validRows = parsedRows.filter((r) => r.isValid);
  const invalidRows = parsedRows.filter((r) => !r.isValid);
  const duplicateRows = parsedRows.filter((r) => r.isDuplicate);

  return (
    <div className="stack page-stack">
      <Link className="back-link" to="/vehicles">
        <ArrowLeft size={16} /> Kho xe
      </Link>
      <PageHeader
        title="Nhập xe từ CSV"
        description="Nạp danh sách xe hàng loạt vào kho an toàn với quy trình kiểm duyệt và ngăn ngừa trùng lặp."
        actions={
          <Button variant="secondary" onClick={downloadVehicleImportTemplate}>
            <Download size={16} /> Tải file mẫu CSV
          </Button>
        }
      />
      {fileError != null && <ErrorState error={fileError} />}

      {step === "upload" && (
        <div className="stack">
          <Card>
            <div
              className="dropzone-area"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                style={{ display: "none" }}
                onChange={handleFileInputChange}
              />
              <FileSpreadsheet size={48} className="dropzone-icon" />
              <h3>Kéo thả file CSV vào đây hoặc bấm để chọn</h3>
              <p className="muted small">
                Hỗ trợ tiếng Việt UTF-8 có dấu. Tải file mẫu để xem cấu trúc các
                cột chuẩn.
              </p>
              <Button
                type="button"
                variant="secondary"
                style={{ marginTop: "12px" }}
              >
                <Upload size={16} /> Chọn file từ máy tính
              </Button>
            </div>
          </Card>

          {isValidating && (
            <div style={{ textAlign: "center", padding: "24px" }}>
              <Loading />
              <p className="muted">
                Đang phân tích và đối soát dữ liệu với cơ sở dữ liệu kho xe…
              </p>
            </div>
          )}

          <Card>
            <h2 className="section-title">Quy tắc nhập dữ liệu an toàn</h2>
            <ul className="guidelines-list">
              <li>
                <strong>Số khung (frame_number):</strong> Là định danh vật lý
                duy nhất của xe, bắt buộc phải có và không được trùng với xe
                đang có trong hệ thống.
              </li>
              <li>
                <strong>Hãng & Dòng xe:</strong> Bắt buộc phải có để hiển thị
                trong kho và quản lý giao dịch.
              </li>
              <li>
                <strong>Giá mua & Giá bán:</strong> Số nguyên VND (vd:
                15000000). Không dùng số âm hoặc số thập phân.
              </li>
              <li>
                <strong>Tính nguyên vẹn:</strong> Dữ liệu được kiểm duyệt 100%
                trước khi lưu. Nếu chọn nhập, giao dịch sẽ được thực hiện nguyên
                tử (atomic), đảm bảo không tạo xe lỗi nửa chừng.
              </li>
            </ul>
          </Card>
        </div>
      )}

      {step === "preview" && (
        <div className="stack">
          {/* Summary KPIs */}
          <div className="kpi-grid">
            <Card className="metric-card">
              <span className="metric-title">Tổng số dòng trong file</span>
              <strong className="metric-value">{parsedRows.length} xe</strong>
              <span className="metric-sub">File: {fileName}</span>
            </Card>
            <Card
              className="metric-card"
              style={{ borderLeft: "4px solid #16a34a" }}
            >
              <span className="metric-title">Dòng hợp lệ sẵn sàng nhập</span>
              <strong
                className="metric-value text-success"
                style={{ color: "#16a34a" }}
              >
                {validRows.length} xe
              </strong>
              <span className="metric-sub">
                Đầy đủ thông tin, không trùng lặp
              </span>
            </Card>
            <Card
              className="metric-card"
              style={{
                borderLeft:
                  invalidRows.length > 0
                    ? "4px solid #dc2626"
                    : "4px solid #e4e9e2",
              }}
            >
              <span className="metric-title">Dòng lỗi dữ liệu</span>
              <strong
                className="metric-value"
                style={{
                  color: invalidRows.length > 0 ? "#dc2626" : "inherit",
                }}
              >
                {invalidRows.length} dòng
              </strong>
              <span className="metric-sub">
                {duplicateRows.length} dòng bị trùng lặp
              </span>
            </Card>
          </div>

          {/* Action Bar */}
          <Card>
            <div
              className="row between"
              style={{ flexWrap: "wrap", gap: "12px", alignItems: "center" }}
            >
              <div className="row" style={{ gap: "8px" }}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setStep("upload");
                    setParsedRows([]);
                  }}
                >
                  <RotateCcw size={16} /> Chọn file khác
                </Button>
              </div>
              <div className="row" style={{ gap: "8px" }}>
                <Button
                  variant="primary"
                  disabled={validRows.length === 0 || importMutation.isPending}
                  onClick={() =>
                    importMutation.mutate(validRows.map((r) => r.data))
                  }
                >
                  <CheckCircle2 size={16} />
                  {importMutation.isPending
                    ? "Đang nhập dữ liệu…"
                    : `Xác nhận nhập ${validRows.length} xe hợp lệ vào kho`}
                </Button>
              </div>
            </div>
            {invalidRows.length > 0 && (
              <p className="notice" role="status">
                Lần nhập này chỉ gồm {validRows.length} dòng hợp lệ.{" "}
                {invalidRows.length} dòng lỗi sẽ được bỏ qua; kiểm tra và nhập
                lại các dòng đó sau.
              </p>
            )}
            {importMutation.isError && (
              <ErrorState error={importMutation.error} />
            )}
          </Card>

          {/* Detailed Preview Table */}
          <Card className="table-card">
            <h2 className="section-title" style={{ padding: "16px 20px 0" }}>
              Bảng kiểm tra chi tiết từng dòng ({parsedRows.length} dòng)
            </h2>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: "60px" }}>STT</th>
                    <th>Trạng thái</th>
                    <th>Số khung</th>
                    <th>Số máy</th>
                    <th>Biển số</th>
                    <th>Xe</th>
                    <th className="numeric">Giá mua</th>
                    <th className="numeric">Giá bán</th>
                    <th>Lý do / Lỗi nếu có</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.map((r) => (
                    <tr
                      key={r.index}
                      className={!r.isValid ? "row-danger" : undefined}
                      style={{
                        backgroundColor: !r.isValid ? "#fff5f5" : undefined,
                      }}
                    >
                      <td>{r.index}</td>
                      <td>
                        {r.isValid ? (
                          <span className="badge badge-completed">
                            <span /> Hợp lệ
                          </span>
                        ) : r.isDuplicate ? (
                          <span className="badge badge-reserved">
                            <span /> Trùng lặp
                          </span>
                        ) : (
                          <span className="badge badge-cancelled">
                            <span /> Lỗi
                          </span>
                        )}
                      </td>
                      <td>
                        <strong>{r.data.frame_number || "—"}</strong>
                      </td>
                      <td>{r.data.engine_number || "—"}</td>
                      <td>{r.data.license_plate || "Chưa biển"}</td>
                      <td>
                        {r.data.brand} {r.data.model}
                        {r.data.year ? ` (${r.data.year})` : ""}
                      </td>
                      <td className="numeric">
                        {money(r.data.purchase_price)}
                      </td>
                      <td className="numeric price">
                        {money(r.data.asking_price)}
                      </td>
                      <td>
                        {r.errors.length > 0 ? (
                          <div
                            style={{
                              color: "#dc2626",
                              fontSize: "12px",
                              display: "flex",
                              flexDirection: "column",
                              gap: "2px",
                            }}
                          >
                            {r.errors.map((err, i) => (
                              <span
                                key={i}
                                className="row"
                                style={{ gap: "4px" }}
                              >
                                <AlertCircle size={13} /> {err}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span
                            className="text-success small row"
                            style={{ gap: "4px", color: "#16a34a" }}
                          >
                            <CheckCircle2 size={14} /> Sẵn sàng nhập
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {step === "success" && (
        <Card style={{ textAlign: "center", padding: "40px 20px" }}>
          <CheckCircle2
            size={54}
            style={{ color: "#16a34a", margin: "0 auto 16px" }}
          />
          <h2>Nhập xe vào kho thành công!</h2>
          <p className="muted">
            Đã tạo mới <strong>{importResult?.count}</strong> xe trong kho và
            lập chứng từ thu vào đầy đủ.
          </p>
          <div
            className="row"
            style={{ justifyContent: "center", gap: "12px", marginTop: "24px" }}
          >
            <Button
              variant="secondary"
              onClick={() => {
                setStep("upload");
                setParsedRows([]);
              }}
            >
              Tiếp tục nhập file khác
            </Button>
            <Button asChild>
              <Link to="/vehicles">
                Xem danh sách tồn kho <ArrowRight size={16} />
              </Link>
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
export default ImportVehiclesPage;
