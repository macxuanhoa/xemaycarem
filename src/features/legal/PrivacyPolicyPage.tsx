import { useEffect } from "react";
import { SHOWROOM_HOTLINE } from "@/features/showroom/showroomLead";
import "./legal.css";

/**
 * Public legal document page: plain text only, no data fetching, no actions.
 *
 * It MUST stay outside the <Protected> route group and must be registered
 * before the catch-all `*` redirect in App.tsx, otherwise every unknown URL —
 * including this one — is bounced to "/" and the visitor lands on the staff
 * login screen. That would make the page unreachable to customers and to any
 * third-party reviewer who asks for a privacy policy URL.
 */

const LAST_UPDATED = "18 tháng 10 năm 2026";

/** Renders the 10-digit hotline as 0914.92.92.92, the form the shop prints. */
const hotlineLabel = (digits: string) =>
  digits.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1.$2.$3.$4");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="legal-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function PrivacyPolicyPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Chính sách quyền riêng tư · Cà Rem";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <main className="legal-page" id="top">
      <header className="legal-head">
        <p className="legal-brand">Cà Rem</p>
        <h1>Chính sách quyền riêng tư</h1>
        <p className="legal-meta">
          Cập nhật lần cuối: {LAST_UPDATED}. Trang này mở công khai, không cần
          đăng nhập.
        </p>
      </header>

      <Section title="1. Phạm vi áp dụng">
        <p>
          Chính sách này áp dụng cho website quản lý cửa hàng xe máy <strong>Cà Rem</strong>{" "}
          (xemaycarem.vercel.app) và toàn bộ dữ liệu mà cửa hàng ghi nhận trong quá
          trình mua bán, thu xe, bảo hành và chăm sóc khách hàng.
        </p>
        <p>
          Cà Rem là một cửa hàng xe máy, không phải sàn giao dịch hay nền tảng quảng
          cáo. Website phục vụ việc bán xe và quản lý nội bộ; chúng tôi không bán,
          không cho thuê và không chia sẻ dữ liệu khách hàng cho mục đích quảng cáo.
        </p>
      </Section>

      <Section title="2. Thông tin chúng tôi ghi nhận">
        <h3>Khách hàng và người bán xe cho cửa hàng</h3>
        <ul>
          <li>Họ tên, số điện thoại, nội dung trao đổi khi hỏi xe hoặc gửi yêu cầu.</li>
          <li>
            Hình ảnh giấy tờ tuỳ thân (CCCD) chỉ khi cửa hàng cần cho hồ sơ thu xe hoặc
            hợp đồng mua bán có thật.
          </li>
          <li>
            Thông tin giao dịch: xe đã bán, số tiền đã trả, khoản còn phải thu, hạn trả nợ.
          </li>
        </ul>
        <h3>Thông tin xe</h3>
        <ul>
          <li>Biển số, số khung, số máy, đời xe, màu sơn, giá thu vào và các khoản chi phí đã bỏ ra.</li>
        </ul>
        <h3>Giao dịch ngân hàng</h3>
        <ul>
          <li>
            Khi bạn chuyển khoản theo mã QR của cửa hàng, hệ thống nhận từ ngân hàng:
            số tiền, thời gian, nội dung chuyển khoản và tên người chuyển, để đối chiếu
            xem khoản tiền đó thuộc đơn hàng nào.
          </li>
        </ul>
        <h3>Nhân viên của cửa hàng</h3>
        <ul>
          <li>Họ tên, tên đăng nhập, vai trò, mật khẩu (lưu dưới dạng mã băm, không lưu dạng đọc được), ngày giờ làm việc.</li>
        </ul>
        <h3>Thông tin kỹ thuật</h3>
        <ul>
          <li>
            Nhật ký thao tác nội bộ (ai sửa gì, lúc nào, giá trị trước và sau) để bảo vệ
            quyền lợi của cả khách và cửa hàng khi có tranh chấp.
          </li>
          <li>Lỗi kỹ thuật của ứng dụng được ghi nhận để sửa. Chúng tôi không cài mã theo dõi của bên thứ ba, không chạy quảng cáo.</li>
        </ul>
      </Section>

      <Section title="3. Mục đích sử dụng">
        <ul>
          <li>Thực hiện việc mua bán, lập hợp đồng, ghi nhận thanh toán và theo dõi công nợ.</li>
          <li>Kiểm tra xem tiền chuyển khoản đã về đúng tài khoản và đúng đơn hàng chưa.</li>
          <li>Chăm sóc khách hàng, nhắc hạn trả nợ, bảo hành, và liên hệ khi cần.</li>
          <li>Bảo vệ hồ sơ: phát hiện thao tác bất thường hoặc sửa xoá không đúng quy định.</li>
        </ul>
      </Section>

      <Section title="4. Ai được xem dữ liệu trong nội bộ cửa hàng">
        <p>
          Hệ thống phân quyền theo từng tài khoản, và quyền này được áp dụng ngay trên
          máy chủ chứ không chỉ ẩn nút trên màn hình:
        </p>
        <ul>
          <li>
            <strong>Nhân viên</strong> chỉ thấy những gì cần cho việc bán xe. Nhân viên
            không xem được giá vốn, lợi nhuận và không tự ghi nhận đã thu tiền.
          </li>
          <li>
            <strong>Quản lý</strong> xem được số thu và duyệt hồ sơ khi được chủ phân
            quyền cụ thể.
          </li>
          <li>
            <strong>Chủ cửa hàng</strong> là người duy nhất xem được toàn bộ, đổi được
            tài khoản nhận tiền và xem nhật ký kiểm toán.
          </li>
        </ul>
      </Section>

      <Section title="5. Đơn vị xử lý dữ liệu thay mặt chúng tôi">
        <p>
          Dữ liệu được lưu trữ và xử lý bởi một số nhà cung cấp hạ tầng sau, và chỉ
          trong phạm vi cần thiết để hệ thống hoạt động:
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> (máy chủ đặt tại khu vực Singapore) — lưu database
            và ảnh hồ sơ.
          </li>
          <li>
            <strong>Vercel</strong> — phục vụ giao diện website.
          </li>
          <li>
            <strong>Dịch vụ thông báo biến động số dư ngân hàng</strong> (SePay / Casso
            và ngân hàng của chủ cửa hàng) — gửi thông tin giao dịch đến để đối soát
            khoản thanh toán.
          </li>
          <li>
            <strong>Google</strong> — dùng cho hai việc: trợ lý tra cứu nghiệp vụ nội bộ
            (chỉ khi chủ cửa hàng bật, và chỉ với dữ liệu xe, không đưa số điện thoại
            riêng hay CCCD vào nội dung công khai), và lưu bản sao dự phòng ở chế độ riêng tư.
          </li>
          <li>
            <strong>Trình duyệt của bạn</strong> — dịch vụ thông báo trên thiết bị chỉ
            hoạt động khi bạn chủ động bấm Cho phép, và bạn tắt được bất cứ lúc nào.
          </li>
        </ul>
        <p>
          Việc nhận dạng biển số và số khung khi quét camera được thực hiện ngay trên
          thiết bị của người thao tác; ảnh chụp giấy tờ thì có lưu vào hệ thống vì đó là
          một phần của hồ sơ mua bán.
        </p>
      </Section>

      <Section title="6. Lưu trữ trên thiết bị của bạn">
        <p>
          Để bạn khỏi phải đăng nhập lại mỗi lần mở, website giữ thông tin phiên trên
          chính máy bạn (bộ nhớ lưu trữ của trình duyệt). Website cũng chạy được lúc mất
          mạng nhờ cơ chế lưu tạm giao diện. Phiên này kết thúc khi bạn bấm Đăng xuất
          hoặc khi hết hạn.
        </p>
      </Section>

      <Section title="7. Thời gian lưu trữ">
        <p>
          Hồ sơ mua bán, hợp đồng và chứng từ được lưu theo thời gian cần thiết cho kế
          toán và thuế. Khi một xe đã có lịch sử mua bán, hệ thống <strong>không cho xoá
          vĩnh viễn</strong> mà chỉ đánh dấu huỷ, để giữ lại dấu vết kiểm toán.
        </p>
        <p>
          Yêu cầu của khách hàng về việc xem, chỉnh sửa hoặc xoá thông tin cá nhân của
          mình sẽ được thực hiện, trừ khi pháp luật buộc cửa hàng phải lưu tiếp chứng từ
          của giao dịch đó.
        </p>
      </Section>

      <Section title="8. Bảo mật">
        <p>
          Chúng tôi áp dụng phân quyền theo vai trò, ghi nhật ký thao tác, bắt buộc đổi
          mật khẩu khi cần, và sao lưu định kỳ. Bản sao lưu chứa dữ liệu thật nên được
          cất ở nơi riêng tư, chỉ chủ cửa hàng truy cập được.
        </p>
        <p>
          Không một hệ thống nào bảo mật tuyệt đối. Nếu xảy ra sự cố liên quan tới dữ
          liệu của bạn, cửa hàng sẽ thông báo và nêu rõ phạm vi ảnh hưởng cùng cách xử lý.
        </p>
      </Section>

      <Section title="9. Quyền của bạn">
        <p>Bạn có quyền, và cửa hàng sẽ thực hiện trong phạm vi pháp luật cho phép:</p>
        <ul>
          <li>Xem lại thông tin của mình đang được lưu.</li>
          <li>Yêu cầu sửa thông tin sai lệch.</li>
          <li>Yêu cầu xoá thông tin, trừ chứng từ bắt buộc phải lưu.</li>
          <li>Rút lại việc cho phép nhận thông báo trên thiết bị.</li>
        </ul>
      </Section>

      <Section title="10. Chia sẻ cho cơ quan nhà nước">
        <p>
          Chỉ khi có yêu cầu hợp pháp bằng văn bản, và chỉ ở phạm vi yêu cầu đó nêu.
        </p>
      </Section>

      <Section title="11. Thay đổi chính sách">
        <p>
          Khi có thay đổi quan trọng, cửa hàng cập nhật ngày ở đầu trang này. Tiếp tục
          giao dịch sau khi bản mới có hiệu lực nghĩa là bạn đồng ý với bản mới.
        </p>
      </Section>

      <Section title="12. Liên hệ">
        <p>
          Mọi yêu cầu về thông tin cá nhân, vui lòng liên hệ cửa hàng qua số{" "}
          <strong>{hotlineLabel(SHOWROOM_HOTLINE)}</strong> hoặc gặp
          trực tiếp tại cửa hàng.
        </p>
      </Section>

      <footer className="legal-foot">
        Cà Rem · Chính sách quyền riêng tư · Cập nhật {LAST_UPDATED}
      </footer>
    </main>
  );
}
