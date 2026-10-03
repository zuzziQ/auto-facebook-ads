const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');

const { reviewContent } = require('./src/services/aiReviewer');

const content = `[TRỊ BỚT OTA] KHÔNG CHỈ CẦN CÔNG NGHỆ, MÀ CẦN ĐÚNG BÁC SĨ VÀ ĐÚNG PHÁC ĐỒ 🩺, Đừng để bớt OTA trở thành rào cản tự tin suốt hàng chục năm. Tại Aeslatek, chúng tôi không bán một "liệu trình Laser chung cho tất cả". Mỗi khách hàng sẽ được thăm khám trực tiếp và xây dựng phác đồ điều trị riêng biệt, dựa trên đặc điểm sắc tố, độ sâu tổn thương và tình trạng nền da.🎁 ƯU ĐÃI THÁNG 3: GIẢM ĐẾN 30% CHI PHÍ (Áp dụng cho 10 khách hàng đăng ký sớm nhất trong tháng) 🌟 TẠI SAO PHẢI LÀ AESLATEK?Bớt OTA là sắc tố nằm sâu ở tầng trung bì, nếu chỉ dùng máy móc mà thiếu kinh nghiệm điều phối năng lượng, da rất dễ bị tăng sắc tố hoặc để lại sẹo.Tại đây, sự khác biệt đến từ: ✅ Phác đồ "May đo" riêng biệt: Không dùng chung một mức năng lượng cho mọi làn da. Bác sĩ sẽ trực tiếp thăm khám, đánh giá độ sâu tổn thương để lên lộ trình chuẩn xác.✅ Chuyên gia hơn 40 năm kinh nghiệm: Được dẫn dắt bởi PGS.TS.BS.TTUT Phạm Hữu Nghị - chuyên gia hàng đầu trong lĩnh vực Laser thẩm mỹ tại Việt Nam.✅ Tổ hợp Laser đa tầng (Pico, Q-Switched, Lavieen): Sự kết hợp hoàn hảo giúp phá hủy sắc tố tầng sâu mà vẫn bảo vệ nền da, giúp da khỏe và đều màu.👇 ĐỪNG TRÌ HOÃN VIỆC TRỞ NÊN ĐẸP HƠN!Chỉ cần để lại từ khóa "OTA" hoặc [Inbox] ngay, đội ngũ bác sĩ Aeslatek sẽ tư vấn 1:1 cho bạn.☎ Đặt lịch thăm khám cùng Aeslatek: 0949.967.319📩 Inbox tư vấn dịch vụ: m.me/aeslatek👉 Tìm hiểu thêm về PGS. Nghị: https://drnghi.com/#Aeslatek #ThamMyCongNgheCao #LamDepAnToan #VietKieuLamDep #CaNhanHoaLamDep #BeautyTrend2026 #ThamMyVienHaNoi—— —— 📍 Phòng khám Laser Thẩm mỹ Công nghệ cao Aeslatek by Dr. Nghị🏠 Địa chỉ: Số 44 Trung Phụng, Văn Miếu - Quốc Tử Giám, Hà Nội🌐 Website: aeslatek.vn`;

async function test() {
  console.log('Running aiReviewer on the exact content from user screenshot...');
  const res = await reviewContent(content);
  console.log('AI Reviewer Result:');
  console.log(JSON.stringify(res, null, 2));
}

test();
