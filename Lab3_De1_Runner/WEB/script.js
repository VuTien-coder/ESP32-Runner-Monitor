// ====== CẤU HÌNH: TOPIC_BASE phải trùng với TOPIC_BASE trong code ESP32 ======
const TOPIC_BASE  = "runner-demo-01";
const BROKER_HOST = "broker.hivemq.com";
const WSS_PORT    = 8884;
const BROKER_URL  = `wss://${BROKER_HOST}:${WSS_PORT}/mqtt`;

const TOPIC_DATA = `${TOPIC_BASE}/data`;
const TOPIC_LED  = `${TOPIC_BASE}/cmd/led`;
const TOPIC_BUZ  = `${TOPIC_BASE}/cmd/buzzer`;
const CLIENT_ID  = "web-" + Math.random().toString(16).slice(2, 10);

const MAX_HISTORY = 120;      // số điểm lưu tối đa
const STALE_MS    = 5000;     // quá 5 s không có dữ liệu => báo mất dữ liệu

const ALERT_TEXT = {
  1: "Nhiệt độ quá cao",
  2: "Nhiệt độ quá thấp",
  4: "Độ cao vượt ngưỡng cho phép",
  8: "Độ cao thấp hơn ngưỡng cho phép",
  16: "Độ cao thay đổi đột ngột"
};

const $ = s => document.querySelector(s);
const setText = (sel, v) => { const e = $(sel); if (e) e.textContent = v; };
const fmt = v => (Number.isFinite(v) ? v.toFixed(2) : "--");
const sign = v => (v >= 0 ? "+" : "") + v.toFixed(2);

// ====== Điền thông tin tĩnh ======
setText(".topic-base", TOPIC_BASE);
setText(".topic-led", TOPIC_LED);
setText(".topic-buz", TOPIC_BUZ);
setText(".conn-host", `${BROKER_HOST}:${WSS_PORT}`);
setText(".info-host", BROKER_HOST);
setText(".info-port", String(WSS_PORT));
setText(".info-data", TOPIC_DATA);
setText(".info-ctl", `${TOPIC_BASE}/cmd/*`);
setText(".info-client", CLIENT_ID);

// ====== Dữ liệu lịch sử + thống kê ======
const hist = { labels: [], temp: [], alt: [] };
let windowPts = 30;

function newStat() { return { min: Infinity, max: -Infinity, sum: 0, n: 0 }; }
const stat = { t: newStat(), p: newStat(), a: newStat() };
function addStat(s, v) { s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.sum += v; s.n++; }
function showStat(prefix, s) {
  setText(`.${prefix}-min`, fmt(s.min));
  setText(`.${prefix}-max`, fmt(s.max));
  setText(`.${prefix}-avg`, s.n ? fmt(s.sum / s.n) : "--");
}

// ====== Biểu đồ ======
function makeChart(canvasId, color) {
  return new Chart($(canvasId), {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        data: [], borderColor: color, borderWidth: 2.5, tension: 0.35, fill: true,
        backgroundColor: c => {
          const { ctx, chartArea } = c.chart;
          if (!chartArea) return color + "22";
          const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, color + "55");
          g.addColorStop(1, color + "05");
          return g;
        },
        pointRadius: c => (c.dataIndex === c.dataset.data.length - 1 ? 5 : 0),
        pointBackgroundColor: color, pointBorderColor: "#fff", pointBorderWidth: 2
      }]
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 5, color: "#6b7788", font: { family: "JetBrains Mono", size: 10 } } },
        y: { grid: { color: "#e8edf3", borderDash: [4, 4] }, ticks: { color: "#6b7788", font: { family: "JetBrains Mono", size: 10 } } }
      }
    }
  });
}
const chartTemp = makeChart("#chartTemp", "#c62828");
const chartAlt  = makeChart("#chartAlt",  "#1565c0");

function renderCharts() {
  const labels = hist.labels.slice(-windowPts);
  const temp = hist.temp.slice(-windowPts);
  const alt = hist.alt.slice(-windowPts);

  chartTemp.data.labels = labels; chartTemp.data.datasets[0].data = temp; chartTemp.update("none");
  chartAlt.data.labels = labels;  chartAlt.data.datasets[0].data = alt;   chartAlt.update("none");

  const sum = a => a.reduce((x, y) => x + y, 0);
  if (temp.length) {
    setText(".ct-avg", fmt(sum(temp) / temp.length) + " °C");
    setText(".ct-max", fmt(Math.max(...temp)) + " °C");
    setText(".ct-min", fmt(Math.min(...temp)) + " °C");
    setText(".ca-avg", fmt(sum(alt) / alt.length) + " m");
    setText(".ca-max", fmt(Math.max(...alt)) + " m");
    setText(".ca-min", fmt(Math.min(...alt)) + " m");
  } else {
    ["ct-avg", "ct-max", "ct-min", "ca-avg", "ca-max", "ca-min"].forEach(c => setText("." + c, "--"));
  }
}

document.querySelectorAll(".range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    windowPts = Number(btn.dataset.pts);
    renderCharts();
  });
});

$(".btn-clear").addEventListener("click", () => {
  hist.labels.length = hist.temp.length = hist.alt.length = 0;
  renderCharts();
});

// ====== Kết nối MQTT ======
const client = mqtt.connect(BROKER_URL, { clientId: CLIENT_ID, reconnectPeriod: 3000 });
let packets = 0, lastMsgAt = 0, prev = null;
let ledOn = false, buzOn = false;

function setConn(cls, pillText, badgeText) {
  $("#conn").className = "mqtt-pill " + cls;
  setText(".conn-text", pillText);
  $("#mqttBadge").className = "live-badge mono " + cls;
  setText(".mqtt-badge-text", badgeText);
}

client.on("connect", () => {
  setConn("live", "MQTT CONNECTED", "ĐÃ KẾT NỐI");
  client.subscribe(TOPIC_DATA);
});
client.on("reconnect", () => setConn("", "MQTT RECONNECTING", "ĐANG KẾT NỐI LẠI"));
client.on("offline",   () => setConn("err", "MQTT OFFLINE", "MẤT KẾT NỐI"));
client.on("error",     () => setConn("err", "MQTT ERROR", "LỖI KẾT NỐI"));

function setChip(sel, text, color) {
  const e = $(sel);
  e.textContent = text;
  e.className = `chip ${color} mono ` + sel.slice(1);
}

client.on("message", (topic, payload) => {
  let d;
  try { d = JSON.parse(payload.toString()); } catch { return; }

  packets++; lastMsgAt = Date.now();
  setText(".packets-rx", packets.toLocaleString("vi-VN"));
  setText(".packets-rx2", packets.toLocaleString("vi-VN"));

  const now = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  setText(".last-update", now);

  // Giá trị chính
  setText(".value-temp", d.t.toFixed(2));
  setText(".value-pressure", d.p.toFixed(2));
  setText(".value-altitude", d.a.toFixed(2));
  setText(".pill-temp", `${now} | ${d.t.toFixed(2)} °C`);
  setText(".pill-alt", `${now} | ${d.a.toFixed(2)} m`);

  // Thống kê + lịch sử
  addStat(stat.t, d.t); addStat(stat.p, d.p); addStat(stat.a, d.a);
  showStat("t", stat.t); showStat("p", stat.p); showStat("a", stat.a);
  hist.labels.push(now); hist.temp.push(d.t); hist.alt.push(d.a);
  if (hist.labels.length > MAX_HISTORY) { hist.labels.shift(); hist.temp.shift(); hist.alt.shift(); }
  renderCharts();

  // Độ lệch so với mẫu trước
  if (prev) {
    setText(".delta-temp", `${sign(d.t - prev.t)} °C`);
    setText(".delta-pressure", `${sign(d.p - prev.p)} hPa`);
    setText(".delta-altitude", `${sign(d.a - prev.a)} m`);
    const dp = Math.abs(d.p - prev.p);
    setChip(".status-pressure", dp < 0.5 ? "ỔN ĐỊNH" : "ĐANG THAY ĐỔI", dp < 0.5 ? "blue" : "orange");
  } else {
    setChip(".status-pressure", "ỔN ĐỊNH", "blue");
  }
  prev = d;

  // Trạng thái theo cảnh báo
  const tempBad = d.alert & (1 | 2);
  const altBad = d.alert & (4 | 8 | 16);
  setChip(".status-temp", tempBad ? "CẢNH BÁO" : "BÌNH THƯỜNG", tempBad ? "red" : "green");
  setChip(".status-altitude", altBad ? "CẢNH BÁO" : "TRONG NGƯỠNG", altBad ? "red" : "green");

  // Thanh cảnh báo
  const msgs = Object.keys(ALERT_TEXT).filter(b => d.alert & b).map(b => ALERT_TEXT[b]);
  const bar = $("#alertBar");
  bar.className = "alert-bar " + (msgs.length ? "bad" : "ok");
  setText(".alert-text", msgs.length ? "Cảnh báo: " + msgs.join(" · ") : "Mọi thông số trong ngưỡng an toàn");

  // Chuyển động
  const mEl = $(".value-motion");
  mEl.textContent = d.m ? "Có người chuyển động" : "Không có chuyển động";
  mEl.classList.toggle("yes", !!d.m);

  // Đèn / còi
  ledOn = !!d.led; buzOn = !!d.buz;
  const modeName = m => (m < 0 ? "AUTO" : "MANUAL");

  setChip(".state-led-badge", ledOn ? "LED ON" : "LED OFF", ledOn ? "green" : "grey");
  setChip(".state-buz-badge", buzOn ? "BUZZER ON" : "BUZZER OFF", buzOn ? "orange" : "grey");
  setText(".mode-led", `${modeName(d.lm)} · ${ledOn ? "đang sáng" : "đang tắt"}`);
  setText(".mode-buz", `${modeName(d.bm)} · ${buzOn ? "đang kêu" : "đang tắt"}`);

  const mark = (prefix, mode) => {
    $(`.btn-${prefix}-on`).classList.toggle("active", mode === 1);
    $(`.btn-${prefix}-off`).classList.toggle("active", mode === 0);
    $(`.btn-${prefix}-auto`).classList.toggle("active", mode < 0);
  };
  mark("led", d.lm);
  mark("buz", d.bm);
});

// ====== Hiển thị trạng thái "mất dữ liệu" ======
setInterval(() => {
  const badge = $("#liveBadge");
  if (!lastMsgAt) return;
  const fresh = Date.now() - lastMsgAt < STALE_MS;
  badge.className = "live-badge mono " + (fresh ? "live" : "err");
  setText(".live-text", fresh ? "LIVE STREAMING (1s)" : "MẤT DỮ LIỆU TỪ ESP32");
}, 1000);

// ====== Nút điều khiển ======
function sendCmd(topic, msg, labelSel) {
  if (!client.connected) return;
  client.publish(topic, msg);
  setText(labelSel, `CMD: ${msg}`);
}
$(".btn-led-on").addEventListener("click",  () => sendCmd(TOPIC_LED, "ON",   ".cmd-led"));
$(".btn-led-off").addEventListener("click", () => sendCmd(TOPIC_LED, "OFF",  ".cmd-led"));
$(".btn-led-auto").addEventListener("click",() => sendCmd(TOPIC_LED, "AUTO", ".cmd-led"));
$(".btn-buz-on").addEventListener("click",  () => sendCmd(TOPIC_BUZ, "ON",   ".cmd-buz"));
$(".btn-buz-off").addEventListener("click", () => sendCmd(TOPIC_BUZ, "OFF",  ".cmd-buz"));
$(".btn-buz-auto").addEventListener("click",() => sendCmd(TOPIC_BUZ, "AUTO", ".cmd-buz"));
