/*
 * Mạch giám sát & cảnh báo người chạy (Runner) - ESP32 + BMP180 + PIR
 *
 * Core 0: taskPublish  - WiFi + MQTT, lấy dữ liệu từ dataQueue và publish
 * Core 1: taskRead     - đọc BMP180, in Serial, đẩy vào dataQueue + alertQueue
 * Core 1: taskAlert    - đọc alertQueue, điều khiển Đèn/Còi (auto + manual)
 */
#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_BMP085.h>   // dùng được cho BMP180
#include <PubSubClient.h>

// ---------------- CHÂN ----------------
#define CHAN_SDA   21
#define CHAN_SCL   22
#define CHAN_DEN   17
#define CHAN_COI   5
#define CHAN_PIR   27

// ---------------- WIFI / MQTT ----------------
const char* WIFI_SSID = "Wokwi-GUEST";   // Wokwi: để nguyên. Mạch thật: đổi tên WiFi
const char* WIFI_PASS = "";
const char* MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;

// Đổi "runner-demo-01" thành chuỗi riêng của bạn (broker public, ai cũng thấy topic)
#define TOPIC_BASE     "runner-demo-01"
#define TOPIC_DATA     TOPIC_BASE "/data"
#define TOPIC_CMD_LED  TOPIC_BASE "/cmd/led"     // ON | OFF | AUTO
#define TOPIC_CMD_BUZ  TOPIC_BASE "/cmd/buzzer"  // ON | OFF | AUTO

// ---------------- NGƯỠNG CẢNH BÁO ----------------
const float TEMP_MAX = 35.0;     // °C, quá nóng
const float TEMP_MIN = 10.0;     // °C, quá lạnh
const float ALT_MAX  = 500.0;    // m, cao quá mức cho phép
const float ALT_MIN  = -50.0;    // m, thấp quá mức cho phép
const float ALT_JUMP_M = 5.0;    // m, thay đổi độ cao giữa 2 lần đọc => "đột ngột"
const float SEA_LEVEL_PA = 101325.0;

const uint32_t READ_PERIOD_MS = 1000;
const uint32_t ALERT_HOLD_MS  = 3000;  // giữ cảnh báo đột ngột 3 s
const uint32_t MOTION_HOLD_MS = 2000;  // giữ đèn sau khi hết chuyển động

// ---------------- CẤU TRÚC DỮ LIỆU ----------------
struct SensorData { float temp; float pressure; float altitude; uint8_t motion; };
struct AlertData  { float temp; float altitude; };

enum : uint8_t {
  ALERT_TEMP_HIGH = 1, ALERT_TEMP_LOW = 2,
  ALERT_ALT_HIGH  = 4, ALERT_ALT_LOW  = 8,
  ALERT_ALT_JUMP  = 16
};

QueueHandle_t dataQueue;    // "data Queue"
QueueHandle_t alertQueue;   // "data Alert"

// Trạng thái dùng chung giữa các task (ghi 1 byte nên không cần mutex)
volatile int8_t  ledMode = -1;   // -1 = AUTO, 0 = OFF, 1 = ON (manual)
volatile int8_t  buzMode = -1;
volatile uint8_t alertCode = 0;
volatile bool    ledState = false, buzState = false, motionState = false;

Adafruit_BMP085 bmp;
WiFiClient espClient;
PubSubClient mqtt(espClient);

// Đẩy dữ liệu vào queue; nếu đầy thì bỏ mẫu cũ nhất
template <typename T>
void pushLatest(QueueHandle_t q, const T& v) {
  if (xQueueSend(q, &v, 0) != pdTRUE) {
    T old;
    xQueueReceive(q, &old, 0);
    xQueueSend(q, &v, 0);
  }
}

// ---------------- MQTT callback (chạy trên Core 0) ----------------
void onMqtt(char* topic, byte* payload, unsigned int len) {
  char msg[8];
  len = min(len, (unsigned int)7);
  memcpy(msg, payload, len);
  msg[len] = 0;

  int8_t m = -1;
  if (strcasecmp(msg, "ON") == 0)  m = 1;
  if (strcasecmp(msg, "OFF") == 0) m = 0;

  if (strcmp(topic, TOPIC_CMD_LED) == 0) ledMode = m;
  else if (strcmp(topic, TOPIC_CMD_BUZ) == 0) buzMode = m;
  Serial.printf("[MQTT] %s = %s\n", topic, msg);
}

// ---------------- TASK TRUYỀN DATA (Core 0) ----------------
void taskPublish(void*) {
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
  mqtt.setBufferSize(256);
  WiFi.mode(WIFI_STA);

  SensorData d;
  char json[200];

  for (;;) {
    // 1) WiFi
    if (WiFi.status() != WL_CONNECTED) {
      Serial.print("[WiFi] Dang ket noi");
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      uint32_t t0 = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) {
        Serial.print(".");
        vTaskDelay(pdMS_TO_TICKS(500));
      }
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println(" that bai, thu lai");
        vTaskDelay(pdMS_TO_TICKS(2000));
        continue;
      }
      Serial.print(" OK, IP: ");
      Serial.println(WiFi.localIP());
    }

    // 2) MQTT
    if (!mqtt.connected()) {
      String id = "runner-" + String((uint32_t)ESP.getEfuseMac(), HEX);
      if (mqtt.connect(id.c_str())) {
        mqtt.subscribe(TOPIC_CMD_LED);
        mqtt.subscribe(TOPIC_CMD_BUZ);
        Serial.println("[MQTT] Da ket noi broker");
      } else {
        Serial.printf("[MQTT] Loi rc=%d, thu lai\n", mqtt.state());
        vTaskDelay(pdMS_TO_TICKS(2000));
        continue;
      }
    }
    mqtt.loop();

    // 3) Có WiFi + MQTT => lấy dữ liệu từ queue và gửi
    if (xQueueReceive(dataQueue, &d, pdMS_TO_TICKS(100)) == pdTRUE) {
      snprintf(json, sizeof(json),
               "{\"t\":%.2f,\"p\":%.2f,\"a\":%.2f,\"m\":%u,"
               "\"led\":%u,\"buz\":%u,\"lm\":%d,\"bm\":%d,\"alert\":%u}",
               d.temp, d.pressure, d.altitude, d.motion,
               ledState, buzState, ledMode, buzMode, alertCode);
      mqtt.publish(TOPIC_DATA, json);
    }
  }
}

// ---------------- TASK ĐỌC DATA (Core 1) ----------------
void taskRead(void*) {
  TickType_t last = xTaskGetTickCount();
  for (;;) {
    float t   = bmp.readTemperature();
    float p   = bmp.readPressure();                 // Pa
    float alt = bmp.readAltitude(SEA_LEVEL_PA);     // m

    SensorData d = { t, p / 100.0f, alt, (uint8_t)motionState };
    AlertData  a = { t, alt };

    Serial.printf("Nhiet do: %.2f C | Ap suat: %.2f hPa | Do cao: %.2f m | PIR: %s\n",
                  d.temp, d.pressure, d.altitude, d.motion ? "CO NGUOI" : "khong");

    pushLatest(dataQueue, d);
    pushLatest(alertQueue, a);

    vTaskDelayUntil(&last, pdMS_TO_TICKS(READ_PERIOD_MS));
  }
}

// ---------------- TASK CẢNH BÁO (Core 1) ----------------
void taskAlert(void*) {
  AlertData a;
  float prevAlt = NAN;
  uint8_t thr = 0;
  uint32_t jumpUntil = 0, motionUntil = 0;
  bool toneOn = false;

  for (;;) {
    // Chờ dữ liệu mới tối đa 100 ms (đồng thời quét PIR liên tục)
    if (xQueueReceive(alertQueue, &a, pdMS_TO_TICKS(100)) == pdTRUE) {
      thr = 0;
      if (a.temp > TEMP_MAX)     thr |= ALERT_TEMP_HIGH;
      if (a.temp < TEMP_MIN)     thr |= ALERT_TEMP_LOW;
      if (a.altitude > ALT_MAX)  thr |= ALERT_ALT_HIGH;
      if (a.altitude < ALT_MIN)  thr |= ALERT_ALT_LOW;
      if (!isnan(prevAlt) && fabsf(a.altitude - prevAlt) > ALT_JUMP_M)
        jumpUntil = millis() + ALERT_HOLD_MS;
      prevAlt = a.altitude;
    }

    uint8_t code = thr;
    if ((int32_t)(jumpUntil - millis()) > 0) code |= ALERT_ALT_JUMP;
    alertCode = code;

    // Chuyển động
    if (digitalRead(CHAN_PIR)) motionUntil = millis() + MOTION_HOLD_MS;
    bool motion = (int32_t)(motionUntil - millis()) > 0;
    motionState = motion;

    // Đèn: AUTO = theo PIR, manual = theo nút web
    bool led = (ledMode < 0) ? motion : (ledMode == 1);
    digitalWrite(CHAN_DEN, led);
    ledState = led;

    // Còi: AUTO = kêu ngắt quãng khi có cảnh báo, manual = theo nút web
    bool wantBuzz = (buzMode < 0) ? (code != 0) : (buzMode == 1);
    bool beepPhase = (buzMode < 0) ? (((millis() / 250) % 2) == 0) : true;
    bool tone_now = wantBuzz && beepPhase;
    if (tone_now != toneOn) {
      toneOn = tone_now;
      if (toneOn) tone(CHAN_COI, 2000);
      else        noTone(CHAN_COI);
    }
    buzState = wantBuzz;
  }
}

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);
  pinMode(CHAN_DEN, OUTPUT);
  pinMode(CHAN_COI, OUTPUT);
  pinMode(CHAN_PIR, INPUT);

  Wire.begin(CHAN_SDA, CHAN_SCL);
  if (!bmp.begin()) {
    Serial.println("Khong tim thay BMP180! Kiem tra day SDA/SCL.");
    while (true) delay(1000);
  }

  dataQueue  = xQueueCreate(10, sizeof(SensorData));
  alertQueue = xQueueCreate(10, sizeof(AlertData));

  xTaskCreatePinnedToCore(taskPublish, "Publish", 8192, NULL, 1, NULL, 0);  // Core 0
  xTaskCreatePinnedToCore(taskRead,    "Read",    4096, NULL, 2, NULL, 1);  // Core 1
  xTaskCreatePinnedToCore(taskAlert,   "Alert",   4096, NULL, 2, NULL, 1);  // Core 1
}

void loop() {
  vTaskDelete(NULL);   // mọi việc đã giao cho các task
}
