# ESP32-Runner-Monitor
# Runner Monitor - Giám sát và cảnh báo người chạy bằng ESP32, FreeRTOS và MQTT
 
Dự án Lab IoT: ESP32 đọc nhiệt độ và áp suất từ cảm biến BMP180, tính độ cao so với mực nước biển, hiển thị qua Serial, gửi dữ liệu lên MQTT Broker qua WiFi và hiển thị/điều khiển trên Web. Hệ thống cảnh báo bằng đèn và còi khi nhiệt độ vượt ngưỡng hoặc độ cao thay đổi đột ngột.
 
## Tính năng
 
- Đọc BMP180 (nhiệt độ, áp suất, độ cao) mỗi 1 giây, in ra Serial.
- Gửi dữ liệu JSON lên MQTT Broker (HiveMQ) qua WiFi.
- Web dashboard: hiển thị số liệu, 2 biểu đồ thời gian thực (nhiệt độ, độ cao), nút điều khiển đèn và còi.
- Cảnh báo bằng còi khi:
  - nhiệt độ quá cao hoặc quá thấp,
  - độ cao vượt ngưỡng cho phép,
  - độ cao thay đổi đột ngột giữa hai lần đọc.
- Đèn tự sáng khi cảm biến PIR phát hiện chuyển động.
- Điều khiển 2 chế độ cho đèn và còi: AUTO (theo cảm biến) và manual (ON/OFF từ Web).
- Chạy đa nhiệm bằng FreeRTOS trên 2 lõi của ESP32, giao tiếp giữa các task bằng hàng đợi (Queue).
