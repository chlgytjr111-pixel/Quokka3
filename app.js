'use strict';

const BAUD_RATE = 115200;
const MAX_DATA_POINTS = 10000;
const MAX_FRAME_LENGTH = 4096;
const RAW_LOG_LINES = 220;
const EMPTY_LOG_MESSAGE = '아직 수신 데이터가 없습니다.';
const IDLE_FRAME_DELAY_MS = 350;

const $ = (id) => document.getElementById(id);

const elements = {
  btnConnect: $('btnConnect'),
  btnDisconnect: $('btnDisconnect'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnClear: $('btnClear'),
  btnCsv: $('btnCsv'),
  btnBaseline: $('btnBaseline'),
  btnClearLog: $('btnClearLog'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  sourceBadge: $('sourceBadge'),
  recordInterval: $('recordInterval'),
  environmentNotice: $('environmentNotice'),
  environmentTitle: $('environmentTitle'),
  environmentText: $('environmentText'),
  distancePanel: $('distancePanel'),
  pressurePanel: $('pressurePanel'),
  distanceValue: $('distanceValue'),
  distanceRaw: $('distanceRaw'),
  distanceMax: $('distanceMax'),
  distanceDemo: $('distanceDemo'),
  distanceDemoLabel: $('distanceDemoLabel'),
  wallGroup: $('wallGroup'),
  beam: $('beam'),
  distanceLine: $('distanceLine'),
  distanceVisualLabel: $('distanceVisualLabel'),
  distanceChart: $('distanceChart'),
  distanceTable: $('distanceTable'),
  distanceCount: $('distanceCount'),
  pressureValue: $('pressureValue'),
  pressureRaw: $('pressureRaw'),
  v0Input: $('v0Input'),
  baselineText: $('baselineText'),
  pressureDemo: $('pressureDemo'),
  pressureDemoLabel: $('pressureDemoLabel'),
  pistonGroup: $('pistonGroup'),
  airFill: $('airFill'),
  syringeVolumeLabel: $('syringeVolumeLabel'),
  pressureChart: $('pressureChart'),
  pressureTable: $('pressureTable'),
  pressureCount: $('pressureCount'),
  rawLog: $('rawLog'),
  toast: $('toast')
};

const sensors = {
  distance: {
    name: '초음파',
    data: [],
    elapsedOffsetSeconds: 0,
    sessionStartedAt: 0,
    lastRecordedAt: Number.NEGATIVE_INFINITY
  },
  pressure: {
    name: '공기압',
    data: [],
    elapsedOffsetSeconds: 0,
    sessionStartedAt: 0,
    lastRecordedAt: Number.NEGATIVE_INFINITY
  }
};

let port = null;
let reader = null;
let readLoopPromise = null;
let keepReading = false;
let isDisconnecting = false;
let decoder = new TextDecoder();
let lineBuffer = '';
let idleFrameTimer = null;

let activeTab = 'distance';
let receivingSensor = null;
let currentDistance = null;
let currentPressure = null;
let currentPressureSource = null;
let pressureBaseline = 1;

let rawLines = [];
let rawRenderScheduled = false;
let toastTimer = null;

function hasSerialSupport() {
  return window.isSecureContext && 'serial' in navigator;
}

function updateEnvironmentNotice() {
  elements.environmentNotice.classList.remove('is-success', 'is-warning');

  if (!window.isSecureContext) {
    elements.environmentNotice.classList.add('is-warning');
    elements.environmentTitle.textContent = 'HTTPS 연결이 필요합니다';
    elements.environmentText.textContent = 'Vercel 배포 주소처럼 HTTPS로 열린 페이지에서 다시 시도하세요.';
    updateControls();
    return;
  }

  if (!('serial' in navigator)) {
    elements.environmentNotice.classList.add('is-warning');
    elements.environmentTitle.textContent = '이 브라우저는 Web Serial을 지원하지 않습니다';
    elements.environmentText.textContent = 'Windows, macOS 또는 ChromeOS의 최신 데스크톱 Chrome/Edge에서 직접 주소를 여세요.';
    updateControls();
    return;
  }

  elements.environmentNotice.classList.add('is-success');
  elements.environmentTitle.textContent = '센서 연결 준비 완료';
  elements.environmentText.textContent = '보드 코드와 같은 센서 탭을 선택한 뒤 장치 연결과 기록 시작을 순서대로 누르세요.';
  updateControls();
}

function setStatus(state, text) {
  elements.statusDot.classList.toggle('is-connected', state === 'connected');
  elements.statusDot.classList.toggle('is-error', state === 'error');
  elements.statusText.textContent = text;
}

function updateControls() {
  const connected = Boolean(port);
  const running = Boolean(receivingSensor);
  const activeHasData = sensors[activeTab].data.length > 0;

  elements.btnConnect.disabled = connected || !hasSerialSupport() || isDisconnecting;
  elements.btnDisconnect.disabled = !connected || isDisconnecting;
  elements.btnStart.disabled = !connected || running || isDisconnecting;
  elements.btnStop.disabled = !connected || !running || isDisconnecting;
  elements.btnCsv.disabled = !activeHasData;
  elements.btnStart.textContent = `${sensors[activeTab].name} 기록 시작`;
  elements.btnStop.textContent = '기록 중지';
  elements.distanceDemo.disabled = running;
  elements.pressureDemo.disabled = running;
  document.querySelectorAll('.demo-panel').forEach((panel) => {
    panel.classList.toggle('is-disabled', running);
  });
}

function resetSerialDecoder() {
  decoder = new TextDecoder();
  lineBuffer = '';
  clearTimeout(idleFrameTimer);
  idleFrameTimer = null;
}

async function connectSerial() {
  if (!hasSerialSupport()) {
    updateEnvironmentNotice();
    showToast('데스크톱 Chrome/Edge와 HTTPS 환경이 필요합니다.', 'error');
    return;
  }

  if (port || isDisconnecting) {
    return;
  }

  let selectedPort = null;

  try {
    selectedPort = await navigator.serial.requestPort();
    await selectedPort.open({
      baudRate: BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none'
    });

    port = selectedPort;
    keepReading = true;
    resetSerialDecoder();
    currentPressure = null;
    currentPressureSource = null;
    elements.pressureValue.textContent = '--';
    elements.pressureRaw.textContent = '센서 데이터 대기 중';
    refreshPressureVisual();
    setStatus('connected', `연결됨 (${BAUD_RATE} bps)`);
    updateControls();

    const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
    const identity = [
      Number.isInteger(info.usbVendorId) ? `VID ${toHex(info.usbVendorId)}` : '',
      Number.isInteger(info.usbProductId) ? `PID ${toHex(info.usbProductId)}` : ''
    ].filter(Boolean).join(' · ');
    appendLog(`▶ 장치에 연결되었습니다.${identity ? ` (${identity})` : ''}`);
    showToast('장치가 연결되었습니다. 센서 탭을 확인한 뒤 기록 시작을 누르세요.', 'success');

    const activePort = port;
    readLoopPromise = readLoop(activePort);
    void readLoopPromise.then(
      () => {
        if (keepReading && port === activePort) {
          void handleUnexpectedDisconnect('장치의 데이터 스트림이 종료되었습니다.');
        }
      },
      (error) => {
        if (keepReading && port === activePort) {
          void handleUnexpectedDisconnect(`수신 오류: ${errorMessage(error)}`);
        }
      }
    );
  } catch (error) {
    if (selectedPort && selectedPort !== port) {
      try {
        await selectedPort.close();
      } catch (_) {
        // The port may not have opened.
      }
    }

    if (error && error.name === 'NotFoundError') {
      setStatus('idle', '장치 연결 전');
      showToast('장치 선택이 취소되었습니다.');
      return;
    }

    setStatus('error', '연결 실패');
    appendLog(`⚠ 연결 실패: ${errorMessage(error)}`);
    showToast(`연결 실패: ${friendlyConnectionError(error)}`, 'error');
    updateControls();
  }
}

async function readLoop(activePort) {
  while (activePort.readable && keepReading && port === activePort) {
    reader = activePort.readable.getReader();

    try {
      while (keepReading && port === activePort) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength) {
          handleBytes(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {
        // The lock may already be released after physical removal.
      }
      reader = null;
    }
  }
}

function handleBytes(bytes) {
  lineBuffer += decoder.decode(bytes, { stream: true });

  const lines = lineBuffer.split(/\r\n|\n|\r/);
  lineBuffer = lines.pop() || '';

  for (const line of lines) {
    const frame = line.trim();
    if (frame.length > MAX_FRAME_LENGTH) {
      appendLog(`⚠ 프레임이 ${MAX_FRAME_LENGTH}자를 초과해 버렸습니다.`);
    } else if (frame) {
      processFrame(frame);
    }
  }

  if (lineBuffer.length > MAX_FRAME_LENGTH) {
    appendLog(`⚠ 미완성 프레임이 ${MAX_FRAME_LENGTH}자를 초과해 버렸습니다.`);
    lineBuffer = '';
  }

  clearTimeout(idleFrameTimer);
  if (lineBuffer.trim()) {
    idleFrameTimer = setTimeout(flushIdleFrame, IDLE_FRAME_DELAY_MS);
  }
}

function flushIdleFrame() {
  const frame = lineBuffer.trim();
  lineBuffer = '';
  idleFrameTimer = null;
  if (frame) {
    appendLog('⚠ 줄바꿈 없이 멈춘 데이터를 한 프레임으로 처리했습니다.');
    processFrame(frame);
  }
}

function processFrame(frame) {
  appendLog(`RX ${shorten(frame, 1000)}`);
  if (!receivingSensor) {
    return;
  }

  if (receivingSensor === 'distance') {
    const distance = parseFirstNumber(frame);
    if (distance !== null && distance >= 0 && distance <= 100000) {
      updateDistance(distance, frame, true);
    }
    return;
  }

  const pressure = parseFirstNumber(frame);
  if (pressure !== null && pressure > 0 && pressure <= 10000) {
    updatePressure(pressure, frame, true);
  }
}

function parseFirstNumber(raw) {
  const match = String(raw).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
  if (!match) {
    return null;
  }
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function startReceiving() {
  if (!port) {
    showToast('먼저 장치에 연결하세요.', 'error');
    return;
  }

  if (receivingSensor) {
    return;
  }

  receivingSensor = activeTab;
  const sensor = sensors[receivingSensor];
  sensor.sessionStartedAt = performance.now();
  sensor.lastRecordedAt = Number.NEGATIVE_INFINITY;

  elements.sourceBadge.hidden = false;
  elements.sourceBadge.textContent = `기록 센서: ${sensor.name}`;
  setStatus('connected', `${sensor.name} 기록 중…`);
  appendLog(`▶ ${sensor.name} 센서 데이터 기록을 시작합니다.`);
  updateControls();
  showToast(`${sensor.name} 데이터 기록을 시작했습니다.`, 'success');
}

function stopReceiving(options = {}) {
  const { silent = false, reason = '' } = options;
  if (!receivingSensor) {
    elements.sourceBadge.hidden = true;
    updateControls();
    return;
  }

  const sensorKey = receivingSensor;
  const sensor = sensors[sensorKey];
  sensor.elapsedOffsetSeconds = elapsedSeconds(sensorKey);
  sensor.sessionStartedAt = 0;
  receivingSensor = null;

  elements.sourceBadge.hidden = true;
  setStatus(port ? 'connected' : 'idle', port ? '대기 중 (연결 유지)' : '장치 연결 전');
  appendLog(`▶ ${sensor.name} 데이터 기록을 중지했습니다.${reason ? ` ${reason}` : ''}`);
  updateControls();

  if (!silent) {
    showToast('기록을 중지했습니다. 포트 연결과 원시 로그 수신은 유지됩니다.');
  }
}

async function disconnectSerial(options = {}) {
  if (isDisconnecting) {
    return;
  }

  const {
    message = '장치 연결 전',
    error = false,
    closePort = true,
    notify = true
  } = options;

  isDisconnecting = true;
  stopReceiving({ silent: true });
  keepReading = false;
  clearTimeout(idleFrameTimer);
  idleFrameTimer = null;
  updateControls();

  const activePort = port;
  const activeReadLoop = readLoopPromise;

  try {
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {
        // Reader cancellation can fail after hardware removal.
      }
    }

    if (activeReadLoop) {
      try {
        await activeReadLoop;
      } catch (_) {
        // The caller reports the failure with a clearer message.
      }
    }

    if (closePort && activePort) {
      try {
        await activePort.close();
      } catch (_) {
        // A physically removed port is already closed.
      }
    }
  } finally {
    reader = null;
    readLoopPromise = null;
    port = null;
    resetSerialDecoder();
    elements.sourceBadge.hidden = true;
    setStatus(error ? 'error' : 'idle', message);
    appendLog(error ? `⚠ ${message}` : '▶ 장치 연결을 해제했습니다.');
    isDisconnecting = false;
    updateControls();

    if (notify) {
      showToast(message, error ? 'error' : 'default');
    }
  }
}

async function handleUnexpectedDisconnect(message) {
  await disconnectSerial({ message, error: true, closePort: false });
}

function selectTab(nextTab) {
  if (!sensors[nextTab] || nextTab === activeTab) {
    return;
  }

  if (receivingSensor && nextTab !== receivingSensor) {
    stopReceiving({
      silent: true,
      reason: '센서 탭이 변경되어 자동으로 중지했습니다.'
    });
    showToast('센서 탭이 바뀌어 기록을 중지했습니다. 새 탭에서 다시 시작하세요.');
  }

  activeTab = nextTab;
  document.querySelectorAll('.tab').forEach((button) => {
    const selected = button.dataset.tab === activeTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  elements.distancePanel.hidden = activeTab !== 'distance';
  elements.pressurePanel.hidden = activeTab !== 'pressure';
  updateControls();

  requestAnimationFrame(() => {
    drawDistanceChart();
    drawPressureChart();
  });
}

function elapsedSeconds(sensorKey) {
  const sensor = sensors[sensorKey];
  if (receivingSensor !== sensorKey || !sensor.sessionStartedAt) {
    return sensor.elapsedOffsetSeconds;
  }
  return sensor.elapsedOffsetSeconds + Math.max(0, (performance.now() - sensor.sessionStartedAt) / 1000);
}

function canRecord(sensorKey) {
  if (receivingSensor !== sensorKey) {
    return false;
  }

  const sensor = sensors[sensorKey];
  const now = performance.now();
  const interval = Math.max(20, Math.min(60000, numberOr(elements.recordInterval.value, 1000)));
  elements.recordInterval.value = String(interval);

  if (now - sensor.lastRecordedAt < interval) {
    return false;
  }

  sensor.lastRecordedAt = now;
  return true;
}

function updateDistance(distance, raw = '', fromSerial = false) {
  if (!Number.isFinite(distance)) {
    return;
  }

  currentDistance = distance;
  elements.distanceValue.textContent = formatNumber(distance, 1);
  elements.distanceRaw.textContent = fromSerial ? `원시값: ${shorten(raw, 120)}` : '화면 테스트 값';
  refreshDistanceVisual();

  if (!fromSerial || !canRecord('distance')) {
    return;
  }

  sensors.distance.data.push({
    timestamp: Date.now(),
    elapsedSeconds: elapsedSeconds('distance'),
    distance,
    raw: String(raw).slice(0, MAX_FRAME_LENGTH)
  });
  trimData(sensors.distance.data);
  renderDistanceTable();
  drawDistanceChart();
  updateControls();
}��-�G����ƭy�ureTable();
  drawPressureChart();
  updateControls();
}

function refreshPressureVisual() {
  const pressure = currentPressure || pressureBaseline;
  const volume = calculateVolume(pressure) ?? getBaselineVolume();
  const shown = Math.max(0, Math.min(60, volume));
  const startX = 135;
  const endX = 555;
  const pistonX = startX + (shown / 60) * (endX - startX);

  elements.pistonGroup.setAttribute('transform', `translate(${pistonX},0)`);
  elements.airFill.setAttribute('width', String(Math.max(1, pistonX - startX)));
  elements.syringeVolumeLabel.setAttribute('x', String(pistonX));
  elements.syringeVolumeLabel.textContent = `${formatNumber(volume, 1)} mL`;
  elements.baselineText.textContent = `P₀ = ${formatNumber(pressureBaseline, 3)} atm, V₀ = ${formatNumber(getBaselineVolume(), 1)} mL`;
}

function setPressureBaseline() {
  if (!currentPressure || currentPressure <= 0 || currentPressureSource !== 'serial') {
    showToast('먼저 센서에서 정상적인 공기압 값을 받아 주세요.', 'error');
    return;
  }
  pressureBaseline = currentPressure;
  recalculatePressureVolumes();
  refreshPressureVisual();
  showToast(`기준압력을 ${formatNumber(pressureBaseline, 3)} atm으로 설정했습니다.`, 'success');
}

function recalculatePressureVolumes() {
  sensors.pressure.data.forEach((record) => {
    record.volume = calculateVolume(record.pressure);
  });
  renderPressureTable();
  drawPressureChart();
}

function updateBaselineVolume() {
  getBaselineVolume();
  recalculatePressureVolumes();
  refreshPressureVisual();
}

function updatePressureDemo() {
  const pressure = numberOr(elements.pressureDemo.value, 100) / 100;
  elements.pressureDemoLabel.textContent = `${formatNumber(pressure, 2)} atm`;
  if (!receivingSensor) {
    updatePressure(pressure, 'DEMO', false);
  }
}

function trimData(data) {
  if (data.length > MAX_DATA_POINTS) {
    data.splice(0, data.length - MAX_DATA_POINTS);
  }
}

function renderDistanceTable() {
  renderTable(
    elements.distanceTable,
    sensors.distance.data,
    (record) => [
      record.elapsedSeconds.toFixed(2),
      formatNumber(record.distance, 2),
      shorten(record.raw, 30)
    ]
  );
  elements.distanceCount.textContent = `${sensors.distance.data.length}개`;
}

function renderPressureTable() {
  renderTable(
    elements.pressureTable,
    sensors.pressure.data,
    (record) => [
      record.elapsedSeconds.toFixed(2),
      formatNumber(record.pressure, 3),
      record.volume === null ? '--' : formatNumber(record.volume, 1)
    ]
  );
  elements.pressureCount.textContent = `${sensors.pressure.data.length}개`;
}

function renderTable(tableBody, data, makeCells) {
  tableBody.replaceChildren();

  if (!data.length) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.textContent = '아직 기록된 값이 없습니다.';
    row.appendChild(cell);
    tableBody.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const record of data.slice(-20).reverse()) {
    const row = document.createElement('tr');
    makeCells(record).forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    fragment.appendChild(row);
  }
  tableBody.appendChild(fragment);
}

function drawDistanceChart() {
  drawChart(
    elements.distanceChart,
    sensors.distance.data.map((record) => ({ x: record.elapsedSeconds, y: record.distance })),
    '시간 (s)',
    '거리 (cm)'
  );
}

function drawPressureChart() {
  drawChart(
    elements.pressureChart,
    sensors.pressure.data.map((record) => ({ x: record.elapsedSeconds, y: record.pressure })),
    '시간 (s)',
    '압력 (atm)'
  );
}

function drawChart(canvas, points, xLabel, yLabel) {
  if (!canvas || canvas.clientWidth === 0) {
    return;
  }

  const width = Math.max(280, canvas.clientWidth);
  const height = Math.max(220, canvas.clientHeight);
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawLineChart(context, width, height, samplePoints(points, 600), xLabel, yLabel);
}

function drawLineChart(context, width, height, points, xLabel, yLabel) {
  const padding = { left: 62, right: 18, top: 18, bottom: 44 };
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  let xMin = 0;
  let xMax = 10;
  let yMin = 0;
  let yMax = 1;

  if (points.length) {
    xMin = points[0].x;
    xMax = points[points.length - 1].x;
    if (xMax <= xMin) {
      xMax = xMin + 1;
    }

    const values = points.map((point) => point.y).filter(Number.isFinite);
    if (values.length) {
      yMin = Math.min(...values);
      yMax = Math.max(...values);
      if (yMax <= yMin) {
        yMin = Math.max(0, yMin - 1);
        yMax += 1;
      }
      const margin = Math.max(0.001, (yMax - yMin) * 0.1);
      yMin = Math.max(0, yMin - margin);
      yMax += margin;
    }
  }

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const projectX = (value) => padding.left + ((value - xMin) / (xMax - xMin)) * plotWidth;
  const projectY = (value) => height - padding.bottom - ((value - yMin) / (yMax - yMin)) * plotHeight;

  context.strokeStyle = '#e8edf4';
  context.lineWidth = 1;
  context.font = '11px Segoe UI, Arial, sans-serif';
  context.fillStyle = '#6b7788';

  for (let index = 0; index <= 5; index += 1) {
    const y = padding.top + (index * plotHeight) / 5;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.textAlign = 'right';
    context.fillText((yMax - (index * (yMax - yMin)) / 5).toFixed(2), padding.left - 7, y + 4);
  }

  for (let index = 0; index <= 5; index += 1) {
    const x = padding.left + (index * plotWidth) / 5;
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, height - padding.bottom);
    context.stroke();
    context.textAlign = 'center';
    context.fillText((xMin + (index * (xMax - xMin)) / 5).toFixed(1), x, height - padding.bottom + 18);
  }

  context.fillStyle = '#475467';
  context.font = '700 12px Segoe UI, Arial, sans-serif';
  context.textAlign = 'center';
  context.fillText(xLabel, (padding.left + width - padding.right) / 2, height - 8);
  context.save();
  context.translate(16, (padding.top + height - padding.bottom) / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(yLabel, 0, 0);
  context.restore();

  if (!points.length) {
    context.fillStyle = '#98a2b3';
    context.font = '14px Segoe UI, Arial, sans-serif';
    context.fillText('기록을 시작하면 그래프가 표시됩니다.', width / 2, height / 2);
    return;
  }

  context.strokeStyle = '#4263eb';
  context.lineWidth = 3;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(projectX(point.x), projectY(point.y));
    } else {
      context.lineTo(projectX(point.x), projectY(point.y));
    }
  });
  context.stroke();

  if (points.length === 1) {
    context.fillStyle = '#4263eb';
    context.beginPath();
    context.arc(projectX(points[0].x), projectY(points[0].y), 4, 0, Math.PI * 2);
    context.fill();
  }
}

function samplePoints(points, limit) {
  if (points.length <= limit) {
    return points;
  }
  const step = Math.ceil(points.length / limit);
  const sampled = points.filter((_, index) => index % step === 0);
  const finalPoint = points[points.length - 1];
  if (sampled[sampled.length - 1] !== finalPoint) {
    sampled.push(finalPoint);
  }
  return sampled;
}

function clearData() {
  Object.values(sensors).forEach((sensor) => {
    sensor.data.length = 0;
    sensor.elapsedOffsetSeconds = 0;
    sensor.lastRecordedAt = Number.NEGATIVE_INFINITY;
    if (sensor.sessionStartedAt) {
      sensor.sessionStartedAt = performance.now();
    }
  });
  renderDistanceTable();
  renderPressureTable();
  drawDistanceChart();
  drawPressureChart();
  updateControls();
  showToast('두 실험의 기록 데이터를 지웠습니다.');
}

function downloadCsv() {
  const data = sensors[activeTab].data;
  if (!data.length) {
    showToast('현재 탭에 저장된 데이터가 없습니다.', 'error');
    return;
  }

  let rows;
  let fileName;

  if (activeTab === 'distance') {
    rows = [
      ['timestamp_iso', 'time_s', 'distance_cm', 'raw'],
      ...data.map((record) => [
        new Date(record.timestamp).toISOString(),
        record.elapsedSeconds.toFixed(3),
        record.distance,
        protectSpreadsheetCell(record.raw)
      ])
    ];
    fileName = `EZMaker_ultrasonic_${localDateStamp()}.csv`;
  } else {
    rows = [
      ['timestamp_iso', 'time_s', 'pressure_atm', 'volume_mL', 'raw'],
      ...data.map((record) => [
        new Date(record.timestamp).toISOString(),
        record.elapsedSeconds.toFixed(3),
        record.pressure,
        record.volume ?? '',
        protectSpreadsheetCell(record.raw)
      ])
    ];
    fileName = `EZMaker_pressure_${localDateStamp()}.csv`;
  }

  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`${data.length}개 값을 CSV로 저장했습니다.`, 'success');
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function protectSpreadsheetCell(value) {
  const text = String(value ?? '');
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function appendLog(text) {
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  String(text).split('\n').forEach((line, index) => {
    rawLines.push(index === 0 ? `[${time}] ${line}` : `           ${line}`);
  });

  if (rawLines.length > RAW_LOG_LINES) {
    rawLines = rawLines.slice(-RAW_LOG_LINES);
  }

  if (!rawRenderScheduled) {
    rawRenderScheduled = true;
    requestAnimationFrame(renderRawLog);
  }
}

function renderRawLog() {
  rawRenderScheduled = false;
  elements.rawLog.textContent = rawLines.length ? rawLines.join('\n') : EMPTY_LOG_MESSAGE;
  elements.rawLog.scrollTop = elements.rawLog.scrollHeight;
}

function clearRawLog() {
  rawLines = [];
  renderRawLog();
}

function showToast(message, kind = 'default') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', kind === 'error');
  elements.toast.classList.toggle('is-success', kind === 'success');
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function shorten(value, length) {
  const text = String(value);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function formatNumber(value, digits) {
  return Number(value).toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function toHex(value) {
  return `0x${Number(value).toString(16).padStart(4, '0').toUpperCase()}`;
}

function localDateStamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error || '알 수 없는 오류');
}

function friendlyConnectionError(error) {
  if (error && error.name === 'NetworkError') {
    return '포트를 열 수 없습니다. 전용 사이트나 시리얼 모니터를 닫고 다시 시도하세요.';
  }
  if (error && error.name === 'InvalidStateError') {
    return '이미 사용 중인 포트입니다. 다른 프로그램의 연결을 해제하세요.';
  }
  if (error && error.name === 'SecurityError') {
    return '브라우저 또는 사이트 정책에서 시리얼 연결이 차단되었습니다.';
  }
  return errorMessage(error);
}

function bindEvents() {
  elements.btnConnect.addEventListener('click', () => void connectSerial());
  elements.btnDisconnect.addEventListener('click', () => void disconnectSerial());
  elements.btnStart.addEventListener('click', startReceiving);
  elements.btnStop.addEventListener('click', () => stopReceiving());
  elements.btnClear.addEventListener('click', clearData);
  elements.btnCsv.addEventListener('click', downloadCsv);
  elements.btnBaseline.addEventListener('click', setPressureBaseline);
  elements.btnClearLog.addEventListener('click', clearRawLog);
  elements.distanceMax.addEventListener('input', refreshDistanceVisual);
  elements.distanceDemo.addEventListener('input', updateDistanceDemo);
  elements.v0Input.addEventListener('input', updateBaselineVolume);
  elements.pressureDemo.addEventListener('input', updatePressureDemo);
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
  });
  window.addEventListener('resize', () => {
    drawDistanceChart();
    drawPressureChart();
  }, { passive: true });

  if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', (event) => {
      const disconnectedPort = event.port || (event.target !== navigator.serial ? event.target : null);
      if (!port || (disconnectedPort && disconnectedPort !== port)) {
        return;
      }
      void disconnectSerial({
        message: 'USB 장치가 분리되었습니다',
        error: true,
        closePort: false
      });
    });
  }

  window.addEventListener('beforeunload', () => {
    keepReading = false;
    if (reader) {
      void reader.cancel().catch(() => {});
    }
  });
}

function initialize() {
  bindEvents();
  updateDistanceDemo();
  updatePressureDemo();
  renderDistanceTable();
  renderPressureTable();
  updateEnvironmentNotice();
  updateControls();
  drawDistanceChart();

  if ('ResizeObserver' in window) {
    const chartObserver = new ResizeObserver(() => {
      drawDistanceChart();
      drawPressureChart();
    });
    chartObserver.observe(elements.distanceChart);
    chartObserver.observe(elements.pressureChart);
  }
}

initialize();
