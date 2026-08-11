'use strict';

const BAUD_RATE = 115200;
const MAX_DATA_POINTS = 10000;
const MAX_FRAME_LENGTH = 4096;
const RAW_PREVIEW_BYTES = 64;
const RAW_LOG_LINES = 180;
const IDLE_FRAME_DELAY_MS = 350;
const EMPTY_LOG_MESSAGE = '아직 수신 데이터가 없습니다.';

const $ = (id) => document.getElementById(id);

const elements = {
  connectBtn: $('connectBtn'),
  disconnectBtn: $('disconnectBtn'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  clearBtn: $('clearBtn'),
  clearLogBtn: $('clearLogBtn'),
  downloadBtn: $('downloadBtn'),
  statusDot: $('statusDot'),
  serialStatus: $('serialStatus'),
  environmentNotice: $('environmentNotice'),
  environmentTitle: $('environmentTitle'),
  environmentText: $('environmentText'),
  recordInterval: $('recordInterval'),
  distanceValue: $('distanceValue'),
  distanceRawText: $('distanceRawText'),
  measurementState: $('measurementState'),
  distanceMax: $('distanceMax'),
  wallGroup: $('wallGroup'),
  distanceLine: $('distanceLine'),
  distanceLabel: $('distanceLabel'),
  distanceScaleMaxLabel: $('distanceScaleMaxLabel'),
  demoPanel: $('demoPanel'),
  distanceDemo: $('distanceDemo'),
  distanceDemoLabel: $('distanceDemoLabel'),
  distanceTable: $('distanceTable'),
  distanceCount: $('distanceCount'),
  distanceChart: $('distanceChart'),
  numberIndex: $('numberIndex'),
  parserScale: $('parserScale'),
  parserOffset: $('parserOffset'),
  rawLog: $('rawLog'),
  toast: $('toast')
};

let port = null;
let reader = null;
let readLoopPromise = null;
let keepReading = false;
let isDisconnecting = false;
let decoder = new TextDecoder();
let serialBuffer = '';
let idleFrameTimer = null;

let isMeasuring = false;
let measurementStartedAt = 0;
let elapsedOffsetSeconds = 0;
let lastRecordedAt = Number.NEGATIVE_INFINITY;
let currentDistanceCm = null;

let rawLines = [];
let rawRenderScheduled = false;
let toastTimer = null;

const data = [];

function hasSerialSupport() {
  return window.isSecureContext && 'serial' in navigator;
}

function updateEnvironmentNotice() {
  elements.environmentNotice.classList.remove('is-success', 'is-warning');

  if (!window.isSecureContext) {
    elements.environmentNotice.classList.add('is-warning');
    elements.environmentTitle.textContent = 'HTTPS 연결이 필요합니다';
    elements.environmentText.textContent = 'Vercel 배포 주소처럼 HTTPS로 열린 페이지에서 다시 시도하세요.';
    elements.connectBtn.disabled = true;
    return;
  }

  if (!('serial' in navigator)) {
    elements.environmentNotice.classList.add('is-warning');
    elements.environmentTitle.textContent = '이 브라우저는 Web Serial을 지원하지 않습니다';
    elements.environmentText.textContent = 'Windows, macOS 또는 ChromeOS의 최신 데스크톱 Chrome/Edge에서 직접 주소를 여세요.';
    elements.connectBtn.disabled = true;
    return;
  }

  elements.environmentNotice.classList.add('is-success');
  elements.environmentTitle.textContent = '센서 연결 준비 완료';
  elements.environmentText.textContent = '장치 연결을 누르면 브라우저가 USB 시리얼 포트 선택 창을 엽니다.';
  elements.connectBtn.disabled = Boolean(port);
}

function setConnectionStatus(state, message) {
  elements.statusDot.classList.toggle('is-connected', state === 'connected');
  elements.statusDot.classList.toggle('is-error', state === 'error');
  elements.serialStatus.textContent = message;
}

function setConnectionControls(connected) {
  elements.connectBtn.disabled = connected || !hasSerialSupport();
  elements.disconnectBtn.disabled = !connected;
  elements.distanceDemo.disabled = connected;
  elements.demoPanel.classList.toggle('is-disabled', connected);
}

function resetSerialSession() {
  decoder = new TextDecoder();
  serialBuffer = '';
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
    await selectedPort.open({ baudRate: BAUD_RATE });

    port = selectedPort;
    keepReading = true;
    resetSerialSession();
    resetLiveReading();
    setConnectionControls(true);
    setConnectionStatus('connected', `${BAUD_RATE} baud 연결됨`);

    const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
    const identity = [
      Number.isInteger(info.usbVendorId) ? `VID ${toHex(info.usbVendorId)}` : '',
      Number.isInteger(info.usbProductId) ? `PID ${toHex(info.usbProductId)}` : ''
    ].filter(Boolean).join(' · ');

    appendRaw(`--- SERIAL CONNECTED @ ${BAUD_RATE}${identity ? ` · ${identity}` : ''} ---`);
    showToast('장치가 연결되었습니다. 값을 확인한 뒤 기록 시작을 누르세요.', 'success');

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
          void handleUnexpectedDisconnect(`읽기 오류: ${errorMessage(error)}`);
        }
      }
    );
  } catch (error) {
    if (selectedPort && selectedPort !== port) {
      try {
        await selectedPort.close();
      } catch (_) {
        // The port may never have opened.
      }
    }

    if (error && error.name === 'NotFoundError') {
      setConnectionStatus('idle', '장치 연결 전');
      showToast('장치 선택이 취소되었습니다.');
      return;
    }

    setConnectionStatus('error', '연결 실패');
    appendRaw(`CONNECT ERROR: ${errorMessage(error)}`);
    showToast(`연결 실패: ${friendlyConnectionError(error)}`, 'error');
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
        // The lock can already be released after a hardware disconnect.
      }
      reader = null;
    }
  }
}

function handleBytes(bytes) {
  const preview = Array.from(bytes.slice(0, RAW_PREVIEW_BYTES))
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
  const truncated = bytes.byteLength > RAW_PREVIEW_BYTES
    ? ` … (+${bytes.byteLength - RAW_PREVIEW_BYTES} bytes)`
    : '';
  const text = decoder.decode(bytes, { stream: true });
  const readableText = text
    ? `\nTXT ${text.replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 500)}`
    : '';

  appendRaw(`HEX ${preview}${truncated}${readableText}`);
  serialBuffer += text;

  if (serialBuffer.length > MAX_FRAME_LENGTH) {
    appendRaw(`FRAME DROPPED: ${MAX_FRAME_LENGTH}자를 초과했습니다.`);
    serialBuffer = '';
    clearTimeout(idleFrameTimer);
    return;
  }

  const frames = serialBuffer.split(/\r\n|\n|\r/);
  serialBuffer = frames.pop() || '';

  for (const frame of frames) {
    const trimmed = frame.trim();
    if (trimmed) {
      handleFrame(trimmed);
    }
  }

  clearTimeout(idleFrameTimer);
  if (serialBuffer.trim()) {
    idleFrameTimer = setTimeout(flushIdleFrame, IDLE_FRAME_DELAY_MS);
  }
}

function flushIdleFrame() {
  const frame = serialBuffer.trim();
  serialBuffer = '';
  idleFrameTimer = null;
  if (frame) {
    appendRaw('NOTICE: 줄바꿈 없이 멈춘 데이터를 한 프레임으로 처리했습니다.');
    handleFrame(frame);
  }
}

function handleFrame(frame) {
  const value = extractNumber(frame);
  if (value === null) {
    return;
  }

  if (value < 0 || value > 100000) {
    appendRaw(`VALUE IGNORED: 거리 범위를 벗어난 값 ${value}`);
    return;
  }

  updateDistance(value, frame, 'serial');
}

function extractNumber(text) {
  const matches = String(text).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!matches || !matches.length) {
    return null;
  }

  const requestedIndex = Math.trunc(numberOr(elements.numberIndex.value, 1));
  const index = Math.max(1, Math.min(100, requestedIndex)) - 1;
  elements.numberIndex.value = String(index + 1);

  if (index >= matches.length) {
    return null;
  }

  const sourceValue = Number(matches[index]);
  if (!Number.isFinite(sourceValue)) {
    return null;
  }

  const scale = numberOr(elements.parserScale.value, 1);
  const offset = numberOr(elements.parserOffset.value, 0);
  const value = sourceValue * scale + offset;
  return Number.isFinite(value) ? value : null;
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
  keepReading = false;
  clearTimeout(idleFrameTimer);
  idleFrameTimer = null;

  const activePort = port;
  const activeReadLoop = readLoopPromise;

  try {
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {
        // Cancellation can fail after a physical disconnect.
      }
    }

    if (activeReadLoop) {
      try {
        await activeReadLoop;
      } catch (_) {
        // The caller reports read failures with a clearer message.
      }
    }

    if (closePort && activePort) {
      try {
        await activePort.close();
      } catch (_) {
        // A physically removed port is already closed by the browser.
      }
    }
  } finally {
    reader = null;
    readLoopPromise = null;
    port = null;
    resetSerialSession();
    setConnectionControls(false);
    setConnectionStatus(error ? 'error' : 'idle', message);
    stopMeasurement({ message: error ? '연결 해제로 기록 중지' : '기록 중지됨', silent: true });
    appendRaw(error ? `--- SERIAL LOST: ${message} ---` : '--- SERIAL DISCONNECTED ---');
    isDisconnecting = false;

    if (notify) {
      showToast(message, error ? 'error' : 'default');
    }
  }
}

async function handleUnexpectedDisconnect(message) {
  await disconnectSerial({ message, error: true, closePort: false });
}

function startMeasurement() {
  if (isMeasuring) {
    return;
  }

  isMeasuring = true;
  measurementStartedAt = performance.now();
  lastRecordedAt = Number.NEGATIVE_INFINITY;
  elements.startBtn.disabled = true;
  elements.stopBtn.disabled = false;
  elements.measurementState.textContent = port ? '실측 기록 중' : '데모 기록 중';
  showToast(port ? '센서 데이터 기록을 시작했습니다.' : '데모 데이터 기록을 시작했습니다.', 'success');
}

function stopMeasurement(options = {}) {
  const { message = '기록 완료', silent = false } = options;

  if (isMeasuring) {
    elapsedOffsetSeconds = currentElapsedSeconds();
  }

  isMeasuring = false;
  measurementStartedAt = 0;
  elements.startBtn.disabled = false;
  elements.stopBtn.disabled = true;
  elements.measurementState.textContent = message;

  if (!silent) {
    showToast('기록을 중지했습니다. 다시 시작하면 같은 시간축에서 이어집니다.');
  }
}

function shouldRecord() {
  if (!isMeasuring) {
    return false;
  }

  const now = performance.now();
  const interval = Math.max(20, Math.min(60000, numberOr(elements.recordInterval.value, 100)));
  elements.recordInterval.value = String(interval);

  if (now - lastRecordedAt < interval) {
    return false;
  }

  lastRecordedAt = now;
  return true;
}

function currentElapsedSeconds() {
  if (!isMeasuring || !measurementStartedAt) {
    return elapsedOffsetSeconds;
  }
  return elapsedOffsetSeconds + Math.max(0, (performance.now() - measurementStartedAt) / 1000);
}

function updateDistance(cm, raw, source) {
  if (!Number.isFinite(cm)) {
    return;
  }

  currentDistanceCm = cm;
  elements.distanceValue.textContent = formatDistance(cm, 1);
  elements.distanceRawText.textContent = source === 'serial' ? `원시값: ${shorten(raw, 120)}` : '데모 입력값';
  refreshDistanceVisual();

  if (!shouldRecord()) {
    return;
  }

  data.push({
    timestamp: Date.now(),
    elapsedSeconds: currentElapsedSeconds(),
    distanceCm: cm,
    source,
    raw: String(raw).slice(0, MAX_FRAME_LENGTH)
  });

  if (data.length > MAX_DATA_POINTS) {
    data.shift();
  }

  renderDistanceTable();
  drawDistanceChart();
}

function refreshDistanceVisual() {
  const maximum = Math.max(10, Math.min(10000, numberOr(elements.distanceMax.value, 200)));
  elements.distanceMax.value = String(maximum);
  elements.distanceScaleMaxLabel.textContent = `${formatDistance(maximum, 0)} cm`;

  if (currentDistanceCm === null) {
    return;
  }

  const clampedDistance = Math.max(0, Math.min(maximum, currentDistanceCm));
  const startX = 145;
  const endX = 660;
  const sensorX = 125;
  const wallX = startX + (clampedDistance / maximum) * (endX - startX);

  elements.wallGroup.setAttribute('transform', `translate(${wallX},0)`);
  elements.distanceLine.setAttribute('x2', String(wallX));
  elements.distanceLabel.setAttribute('x', String((sensorX + wallX) / 2));
  elements.distanceLabel.textContent = `${formatDistance(currentDistanceCm, 1)} cm`;
}

function resetLiveReading() {
  currentDistanceCm = null;
  elements.distanceValue.textContent = '--';
  elements.distanceRawText.textContent = '원시 데이터 대기 중';
  elements.wallGroup.setAttribute('transform', 'translate(390,0)');
  elements.distanceLine.setAttribute('x2', '390');
  elements.distanceLabel.setAttribute('x', '257');
  elements.distanceLabel.textContent = '-- cm';
}

function updateDemoDistance() {
  const value = numberOr(elements.distanceDemo.value, 100);
  elements.distanceDemoLabel.textContent = `${formatDistance(value, 0)} cm`;

  if (port) {
    return;
  }

  updateDistance(value, `DEMO:${value}`, 'demo');
}

function clearCurrent() {
  data.length = 0;
  elapsedOffsetSeconds = 0;
  lastRecordedAt = Number.NEGATIVE_INFINITY;

  if (isMeasuring) {
    measurementStartedAt = performance.now();
    elements.measurementState.textContent = port ? '실측 기록 중' : '데모 기록 중';
  } else {
    elements.measurementState.textContent = '데이터 없음';
  }

  renderDistanceTable();
  drawDistanceChart();
  showToast('기록 데이터를 지웠습니다.');
}

function renderDistanceTable() {
  elements.distanceTable.replaceChildren();

  if (!data.length) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.textContent = '아직 기록된 값이 없습니다.';
    row.appendChild(cell);
    elements.distanceTable.appendChild(row);
  } else {
    const fragment = document.createDocumentFragment();
    const rows = data.slice(-20).reverse();

    for (const record of rows) {
      const row = document.createElement('tr');
      const timeCell = document.createElement('td');
      const distanceCell = document.createElement('td');
      const rawCell = document.createElement('td');

      timeCell.textContent = record.elapsedSeconds.toFixed(2);
      distanceCell.textContent = formatDistance(record.distanceCm, 2);
      rawCell.textContent = shorten(record.raw, 28);
      rawCell.title = record.raw;

      row.append(timeCell, distanceCell, rawCell);
      fragment.appendChild(row);
    }

    elements.distanceTable.appendChild(fragment);
  }

  elements.distanceCount.textContent = `${data.length}개`;
  elements.downloadBtn.disabled = !data.length;
}

function drawDistanceChart() {
  const canvas = elements.distanceChart;
  const width = Math.max(280, canvas.clientWidth || 700);
  const height = Math.max(220, canvas.clientHeight || 280);
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawLineChart(context, width, height, data.map((record) => ({
    x: record.elapsedSeconds,
    y: record.distanceCm
  })));
}

function drawLineChart(context, width, height, points) {
  const padding = { left: 58, right: 18, top: 18, bottom: 44 };
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  const plotted = samplePoints(points, 600);
  let xMin = 0;
  let xMax = 10;
  let yMin = 0;
  let yMax = 1;

  if (plotted.length) {
    xMin = plotted[0].x;
    xMax = plotted[plotted.length - 1].x;
    if (xMax <= xMin) {
      xMax = xMin + 1;
    }

    const values = plotted.map((point) => point.y).filter(Number.isFinite);
    if (values.length) {
      yMin = Math.min(...values);
      yMax = Math.max(...values);
      if (yMax <= yMin) {
        yMin = Math.max(0, yMin - 1);
        yMax += 1;
      }
      const margin = Math.max(0.5, (yMax - yMin) * 0.12);
      yMin = Math.max(0, yMin - margin);
      yMax += margin;
    }
  }

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const projectX = (value) => padding.left + ((value - xMin) / (xMax - xMin)) * plotWidth;
  const projectY = (value) => height - padding.bottom - ((value - yMin) / (yMax - yMin)) * plotHeight;

  context.strokeStyle = '#e6ebf2';
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
    context.fillText((yMax - (index * (yMax - yMin)) / 5).toFixed(1), padding.left - 7, y + 4);
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
  context.fillText('시간 (s)', (padding.left + width - padding.right) / 2, height - 8);
  context.save();
  context.translate(15, (padding.top + height - padding.bottom) / 2);
  context.rotate(-Math.PI / 2);
  context.fillText('거리 (cm)', 0, 0);
  context.restore();

  if (!plotted.length) {
    context.fillStyle = '#98a2b3';
    context.font = '14px Segoe UI, Arial, sans-serif';
    context.fillText('기록을 시작하면 그래프가 표시됩니다.', width / 2, height / 2);
    return;
  }

  context.strokeStyle = '#3658d4';
  context.lineWidth = 3;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();

  plotted.forEach((point, index) => {
    const x = projectX(point.x);
    const y = projectY(point.y);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();

  if (plotted.length === 1) {
    context.fillStyle = '#3658d4';
    context.beginPath();
    context.arc(projectX(plotted[0].x), projectY(plotted[0].y), 4, 0, Math.PI * 2);
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

function downloadCsv() {
  if (!data.length) {
    showToast('저장할 데이터가 없습니다.', 'error');
    return;
  }

  const rows = [
    ['timestamp_iso', 'time_s', 'distance_cm', 'source', 'raw'],
    ...data.map((record) => [
      new Date(record.timestamp).toISOString(),
      record.elapsedSeconds.toFixed(3),
      record.distanceCm,
      record.source,
      protectSpreadsheetCell(record.raw)
    ])
  ];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `EZMaker_distance_${localDateStamp()}.csv`;
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

function appendRaw(text) {
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const lines = String(text).split('\n');
  lines.forEach((line, index) => {
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

function formatDistance(value, digits) {
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
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
  elements.connectBtn.addEventListener('click', () => void connectSerial());
  elements.disconnectBtn.addEventListener('click', () => void disconnectSerial());
  elements.startBtn.addEventListener('click', startMeasurement);
  elements.stopBtn.addEventListener('click', () => stopMeasurement());
  elements.clearBtn.addEventListener('click', clearCurrent);
  elements.clearLogBtn.addEventListener('click', clearRawLog);
  elements.downloadBtn.addEventListener('click', downloadCsv);
  elements.distanceMax.addEventListener('input', refreshDistanceVisual);
  elements.distanceDemo.addEventListener('input', updateDemoDistance);
  window.addEventListener('resize', drawDistanceChart, { passive: true });

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
  updateEnvironmentNotice();
  setConnectionControls(false);
  renderDistanceTable();
  refreshDistanceVisual();
  drawDistanceChart();

  if ('ResizeObserver' in window) {
    const chartObserver = new ResizeObserver(() => drawDistanceChart());
    chartObserver.observe(elements.distanceChart);
  }
}

initialize();
