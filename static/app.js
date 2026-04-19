const state = {
  fixedPrompt: "服务端固定 Prompt 已更新为双图输入版本：图1用于理解，图2用于生成。",
  canvas: null,
  sketchStrokes: [],
  currentStroke: null,
  brushColor: "#ff6242",
  currentSticker: null,
  staticMode: false,
  cameraStream: null,
  faceLandmarkerVideo: null,
  faceLandmarkerImage: null,
  trackingLoopStarted: false,
  lastTrackedVideoTime: -1,
  lastFaceResult: null,
  initialFaceResult: null,
  binding: null,
  lockedGenerationInputs: null,
  multi: {
    roomId: "",
    role: "",
    userId: "",
    remoteUserId: "",
    pollTimer: null,
    latestRemoteFrame: null,
    peerConnection: null,
    remoteStream: null,
    isMakingOffer: false,
    remoteSketchStrokes: [],
    currentRemoteStroke: null,
    remoteSticker: null,
    remoteViewMode: "video",
    remoteBinding: null,
    remoteInitialFaceResult: null,
    incomingSticker: null,
    incomingBinding: null,
    incomingInitialFaceResult: null,
    lastRemoteTrackedVideoTime: -1,
  },
};

const FACE_TRACKER_BUNDLE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";
const FACE_TRACKER_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const FACE_TRACKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const els = {
  tabs: [...document.querySelectorAll(".tab-button")],
  panels: {
    create: document.querySelector("#panel-create"),
    multi: document.querySelector("#panel-multi"),
    assets: document.querySelector("#panel-assets"),
  },
  fixedPrompt: document.querySelector("#fixed-prompt"),
  generationOverlay: document.querySelector("#generation-overlay"),
  capturePhoto: document.querySelector("#capture-photo"),
  brushHue: document.querySelector("#brush-hue"),
  brushColorPreview: document.querySelector("#brush-color-preview"),
  baseImage: document.querySelector("#base-image"),
  cameraFeed: document.querySelector("#camera-feed"),
  previewFeed: document.querySelector("#preview-feed"),
  previewStage: document.querySelector("#preview-stage"),
  stage: document.querySelector("#camera-stage"),
  sketchLayer: document.querySelector("#sketch-layer"),
  stickerPreview: document.querySelector("#sticker-preview"),
  statusText: document.querySelector("#status-text"),
  inputImageList: document.querySelector("#input-image-list"),
  stickerMeta: document.querySelector("#sticker-meta"),
  candidateList: document.querySelector("#candidate-list"),
  generateButton: document.querySelector("#generate-sticker"),
  clearSketch: document.querySelector("#clear-sketch"),
  saveSticker: document.querySelector("#save-sticker"),
  saveTemplate: document.querySelector("#save-template"),
  saveCapture: document.querySelector("#save-capture"),
  discoverList: document.querySelector("#discover-list"),
  mineTemplates: document.querySelector("#mine-templates"),
  mineAssets: document.querySelector("#mine-assets"),
  anchorButtons: document.querySelector("#anchor-buttons"),
  trackingStatus: document.querySelector("#tracking-status"),
  toggleStaticMode: document.querySelector("#toggle-static-mode"),
  multiDisplayName: document.querySelector("#multi-display-name"),
  multiRoomId: document.querySelector("#multi-room-id"),
  multiCreateRoom: document.querySelector("#multi-create-room"),
  multiJoinRoom: document.querySelector("#multi-join-room"),
  multiCopyRoom: document.querySelector("#multi-copy-room"),
  multiStartCamera: document.querySelector("#multi-start-camera"),
  multiStartRealtime: document.querySelector("#multi-start-realtime"),
  multiSendFrame: document.querySelector("#multi-send-frame"),
  multiRefreshFrame: document.querySelector("#multi-refresh-frame"),
  multiBackToVideo: document.querySelector("#multi-back-to-video"),
  multiClearSketch: document.querySelector("#multi-clear-sketch"),
  multiGenerateSticker: document.querySelector("#multi-generate-sticker"),
  multiSendSticker: document.querySelector("#multi-send-sticker"),
  multiLocalStage: document.querySelector("#multi-local-stage"),
  multiRemoteStage: document.querySelector("#multi-remote-stage"),
  multiLocalVideo: document.querySelector("#multi-local-video"),
  multiLocalStickerPreview: document.querySelector("#multi-local-sticker-preview"),
  multiRemoteVideo: document.querySelector("#multi-remote-video"),
  multiRemoteFrame: document.querySelector("#multi-remote-frame"),
  multiRemoteStickerPreview: document.querySelector("#multi-remote-sticker-preview"),
  multiRemoteSketchLayer: document.querySelector("#multi-remote-sketch-layer"),
  multiRemoteCandidateList: document.querySelector("#multi-remote-candidate-list"),
  multiConnectionState: document.querySelector("#multi-connection-state"),
  multiRoomLabel: document.querySelector("#multi-room-label"),
  multiRoleLabel: document.querySelector("#multi-role-label"),
  multiRemoteLabel: document.querySelector("#multi-remote-label"),
};

const ctx = els.sketchLayer.getContext("2d");
const multiRemoteCtx = els.multiRemoteSketchLayer.getContext("2d");

function setStatus(message) {
  els.statusText.textContent = message;
}

function setTrackingStatus(message) {
  els.trackingStatus.textContent = message;
}

function setGenerationOverlay(visible) {
  els.generationOverlay.classList.toggle("active", visible);
  els.generationOverlay.setAttribute("aria-hidden", String(!visible));
}

function setMultiConnectionState(message) {
  els.multiConnectionState.textContent = message;
}

function buildRtcConfig() {
  return {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  };
}

function closePeerConnection() {
  if (state.multi.peerConnection) {
    state.multi.peerConnection.onicecandidate = null;
    state.multi.peerConnection.ontrack = null;
    state.multi.peerConnection.onnegotiationneeded = null;
    state.multi.peerConnection.onconnectionstatechange = null;
    state.multi.peerConnection.close();
    state.multi.peerConnection = null;
  }
}

async function sendSignal(type, payload) {
  if (!state.multi.roomId || !state.multi.userId || !state.multi.remoteUserId) return;
  await api("/api/room/signal", "POST", {
    roomId: state.multi.roomId,
    fromUserId: state.multi.userId,
    toUserId: state.multi.remoteUserId,
    type,
    payload,
  });
}

async function ensurePeerConnection() {
  if (state.multi.peerConnection) return state.multi.peerConnection;
  const pc = new RTCPeerConnection(buildRtcConfig());
  state.multi.peerConnection = pc;

  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => {
      const exists = pc.getSenders().some((sender) => sender.track === track);
      if (!exists) pc.addTrack(track, state.cameraStream);
    });
  }

  pc.onicecandidate = async (event) => {
    if (!event.candidate) return;
    try {
      await sendSignal("ice", event.candidate.toJSON());
    } catch (error) {
      setMultiConnectionState(`ICE 发送失败：${error.message}`);
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    state.multi.remoteStream = stream;
    els.multiRemoteVideo.srcObject = stream;
    if (state.multi.remoteViewMode !== "frame") {
      els.multiRemoteVideo.style.display = "block";
      els.multiRemoteFrame.style.display = "none";
      els.multiRemoteSketchLayer.style.display = "none";
    }
    setMultiConnectionState("已连接对方实时视频");
  };

  pc.onconnectionstatechange = () => {
    const stateText = pc.connectionState || "连接中";
    if (stateText === "connected") {
      setMultiConnectionState("实时视频已连接");
    } else if (stateText === "connecting") {
      setMultiConnectionState("正在建立实时视频连接...");
    } else if (stateText === "failed") {
      setMultiConnectionState("实时视频连接失败");
    }
  };

  pc.onnegotiationneeded = async () => {
    if (!state.multi.remoteUserId || state.multi.isMakingOffer) return;
    try {
      state.multi.isMakingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal("offer", pc.localDescription.toJSON());
      setMultiConnectionState("已发送视频连接请求");
    } catch (error) {
      setMultiConnectionState(`发起连接失败：${error.message}`);
    } finally {
      state.multi.isMakingOffer = false;
    }
  };

  return pc;
}

async function handleIncomingSignal(signal) {
  const pc = await ensurePeerConnection();
  if (signal.type === "offer") {
    await pc.setRemoteDescription(signal.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal("answer", pc.localDescription.toJSON());
    setMultiConnectionState("已响应对方的视频连接");
    return;
  }
  if (signal.type === "answer") {
    await pc.setRemoteDescription(signal.payload);
    setMultiConnectionState("对方已接受视频连接");
    return;
  }
  if (signal.type === "ice" && signal.payload) {
    try {
      await pc.addIceCandidate(signal.payload);
    } catch (error) {
      setMultiConnectionState(`ICE 应用失败：${error.message}`);
    }
  }
}

function updateBrushPreview() {
  els.brushColorPreview.style.background = state.brushColor;
}

function switchTab(tab) {
  els.tabs.forEach((tabEl) => tabEl.classList.toggle("active", tabEl.dataset.tab === tab));
  Object.entries(els.panels).forEach(([key, panel]) => panel.classList.toggle("active", key === tab));
}

function resizeCanvasToImage() {
  const rect = els.stage.getBoundingClientRect();
  els.sketchLayer.width = rect.width;
  els.sketchLayer.height = rect.height;
  redrawSketch();
  repositionSticker();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getCoverLayout(containerEl, sourceWidth, sourceHeight) {
  const rect = containerEl.getBoundingClientRect();
  const safeWidth = Math.max(1, sourceWidth || rect.width || 1);
  const safeHeight = Math.max(1, sourceHeight || rect.height || 1);
  const scale = Math.max(rect.width / safeWidth, rect.height / safeHeight);
  const renderWidth = safeWidth * scale;
  const renderHeight = safeHeight * scale;
  return {
    rect,
    scale,
    renderWidth,
    renderHeight,
    offsetX: (rect.width - renderWidth) / 2,
    offsetY: (rect.height - renderHeight) / 2,
    sourceWidth: safeWidth,
    sourceHeight: safeHeight,
  };
}

function stagePointToImagePoint(point, containerEl = els.stage, sourceWidth = state.canvas?.width, sourceHeight = state.canvas?.height) {
  const layout = getCoverLayout(containerEl, sourceWidth, sourceHeight);
  return {
    x: clamp((point.x - layout.offsetX) / layout.scale, 0, layout.sourceWidth),
    y: clamp((point.y - layout.offsetY) / layout.scale, 0, layout.sourceHeight),
  };
}

function imagePointToStagePoint(point, containerEl, sourceWidth, sourceHeight) {
  const layout = getCoverLayout(containerEl, sourceWidth, sourceHeight);
  return {
    x: point.x * layout.scale + layout.offsetX,
    y: point.y * layout.scale + layout.offsetY,
    scale: layout.scale,
  };
}

function getPreviewSourceDimensions() {
  return {
    width: els.previewFeed.videoWidth || state.canvas?.width || 1,
    height: els.previewFeed.videoHeight || state.canvas?.height || 1,
  };
}

function drawSketchStrokesToContext(targetCtx, targetWidth, targetHeight) {
  if (!state.sketchStrokes.length) return;
  const layout = getCoverLayout(els.stage, targetWidth, targetHeight);
  targetCtx.lineWidth = Math.max(4, 6 / layout.scale);
  targetCtx.lineCap = "round";
  targetCtx.lineJoin = "round";
  state.sketchStrokes.forEach((stroke) => {
    if (!stroke.points.length) return;
    targetCtx.strokeStyle = stroke.color;
    targetCtx.beginPath();
    stroke.points.forEach((point, index) => {
      const mapped = stagePointToImagePoint(point, els.stage, targetWidth, targetHeight);
      if (index === 0) targetCtx.moveTo(mapped.x, mapped.y);
      else targetCtx.lineTo(mapped.x, mapped.y);
    });
    targetCtx.stroke();
  });
}

function redrawSketch() {
  ctx.clearRect(0, 0, els.sketchLayer.width, els.sketchLayer.height);
  if (!state.sketchStrokes.length) return;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  state.sketchStrokes.forEach((stroke) => {
    if (!stroke.points.length) return;
    ctx.strokeStyle = stroke.color;
    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  });
}

function resizeMultiRemoteSketchLayer() {
  const rect = els.multiRemoteStage.getBoundingClientRect();
  els.multiRemoteSketchLayer.width = rect.width;
  els.multiRemoteSketchLayer.height = rect.height;
  redrawMultiRemoteSketch();
}

function getMultiRemotePointerPoint(event) {
  const rect = els.multiRemoteSketchLayer.getBoundingClientRect();
  return {
    x: clamp(event.clientX - rect.left, 0, rect.width),
    y: clamp(event.clientY - rect.top, 0, rect.height),
  };
}

function redrawMultiRemoteSketch() {
  multiRemoteCtx.clearRect(0, 0, els.multiRemoteSketchLayer.width, els.multiRemoteSketchLayer.height);
  if (!state.multi.remoteSketchStrokes.length) return;
  multiRemoteCtx.lineWidth = 6;
  multiRemoteCtx.lineCap = "round";
  multiRemoteCtx.lineJoin = "round";
  state.multi.remoteSketchStrokes.forEach((stroke) => {
    if (!stroke.points.length) return;
    multiRemoteCtx.strokeStyle = stroke.color;
    multiRemoteCtx.beginPath();
    stroke.points.forEach((point, index) => {
      if (index === 0) multiRemoteCtx.moveTo(point.x, point.y);
      else multiRemoteCtx.lineTo(point.x, point.y);
    });
    multiRemoteCtx.stroke();
  });
}

function clearMultiRemoteSketch(keepCandidates = false) {
  state.multi.remoteSketchStrokes = [];
  state.multi.currentRemoteStroke = null;
  redrawMultiRemoteSketch();
  if (!keepCandidates) {
    state.multi.remoteSticker = null;
    renderMultiRemoteCandidateList();
  }
}

function getAllSketchPoints() {
  return state.sketchStrokes.flatMap((stroke) => stroke.points);
}

function renderBindingBadge() {
  els.anchorButtons.innerHTML = "";
  const badge = document.createElement("button");
  badge.disabled = true;
  badge.className = "auto-bound active";
  if (!state.binding) {
    badge.textContent = "等待草图绑定";
  } else {
    badge.textContent = `草图绑定点 #${state.binding.landmarkIndex}`;
  }
  els.anchorButtons.appendChild(badge);
}

function updateMeta() {
  els.stickerMeta.innerHTML = "";
  if (!state.currentSticker) {
    els.stickerMeta.innerHTML = '<div class="meta-chip">还没有生成贴图</div>';
    return;
  }
  const rows = [
    `草图绑定点：${state.binding ? `landmark #${state.binding.landmarkIndex}` : "未绑定"}`,
    `草图中心：${state.binding ? `${state.binding.center.x.toFixed(3)}, ${state.binding.center.y.toFixed(3)}` : "-"}`,
    `贴图尺寸：${state.currentSticker.width || "-"} × ${state.currentSticker.height || "-"}`,
    `模式：${state.staticMode ? "静态摆放" : "草图点位实时跟踪"}`,
  ];
  rows.forEach((text) => {
    const div = document.createElement("div");
    div.className = "meta-chip";
    div.textContent = text;
    els.stickerMeta.appendChild(div);
  });
}

function renderCandidateList() {
  els.candidateList.innerHTML = "";
  if (!state.currentSticker?.image_data_urls?.length) {
    const empty = document.createElement("div");
    empty.className = "tile";
    empty.innerHTML = "<h3>还没有候选贴图</h3><p>生成后会在这里显示三张候选图。</p>";
    els.candidateList.appendChild(empty);
    return;
  }

  state.currentSticker.image_data_urls.forEach((candidateUrl, index) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    if (candidateUrl === state.currentSticker.image_data_url) {
      tile.classList.add("selected");
    }
    tile.innerHTML = `
      <img src="${candidateUrl}" alt="候选贴图 ${index + 1}" />
      <h3>候选 ${index + 1}</h3>
      <p>${candidateUrl === state.currentSticker.image_data_url ? "当前预览中" : "点击切换到这张"}</p>
    `;
    tile.addEventListener("click", () => {
      state.currentSticker.image_data_url = candidateUrl;
      els.stickerPreview.src = candidateUrl;
      renderCandidateList();
      repositionSticker();
      setStatus(`已切换到候选贴图 ${index + 1}`);
    });
    els.candidateList.appendChild(tile);
  });
}

function renderInputImages(sketchImageDataUrl = null) {
  els.inputImageList.innerHTML = "";
  if (!sketchImageDataUrl) {
    const empty = document.createElement("div");
    empty.className = "tile";
    empty.innerHTML = "<p>生成后会在这里显示实际发给模型的草图图像。</p>";
    els.inputImageList.appendChild(empty);
    return;
  }
  els.inputImageList.appendChild(
    makeTile({
      title: "草图输入",
      description: "仅草图送模，底图只用于绑定与实时跟踪",
      preview: sketchImageDataUrl,
    })
  );
}

function renderMultiRemoteCandidateList() {
  els.multiRemoteCandidateList.innerHTML = "";
  if (!state.multi.remoteSticker?.image_data_urls?.length) {
    const empty = document.createElement("div");
    empty.className = "tile";
    empty.innerHTML = "<h3>还没有给对方生成贴图</h3><p>先拉取对方画面，在冻结帧上画草图，再点击生成。</p>";
    els.multiRemoteCandidateList.appendChild(empty);
    return;
  }

  state.multi.remoteSticker.image_data_urls.forEach((candidateUrl, index) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    if (candidateUrl === state.multi.remoteSticker.image_data_url) {
      tile.classList.add("selected");
    }
    tile.innerHTML = `
      <img src="${candidateUrl}" alt="给对方的候选贴图 ${index + 1}" />
      <h3>候选 ${index + 1}</h3>
      <p>${candidateUrl === state.multi.remoteSticker.image_data_url ? "当前选中，下一步可发给对方" : "点击切换当前候选"}</p>
    `;
    tile.addEventListener("click", () => {
      state.multi.remoteSticker.image_data_url = candidateUrl;
      renderMultiRemoteCandidateList();
      setMultiConnectionState(`已切换到给对方的候选贴图 ${index + 1}`);
    });
    els.multiRemoteCandidateList.appendChild(tile);
  });
}

function syncPreviewFeed() {
  if (!state.cameraStream) return;
  els.cameraFeed.srcObject = state.cameraStream;
  els.previewFeed.srcObject = state.cameraStream;
  if (els.multiLocalVideo) {
    els.multiLocalVideo.srcObject = state.cameraStream;
  }
}

async function ensureFaceTrackers() {
  if (state.faceLandmarkerVideo && state.faceLandmarkerImage) return;
  setTrackingStatus("初始化关键点跟踪...");
  const vision = await import(FACE_TRACKER_BUNDLE_URL);
  const filesetResolver = await vision.FilesetResolver.forVisionTasks(FACE_TRACKER_WASM_URL);

  state.faceLandmarkerVideo = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { modelAssetPath: FACE_TRACKER_MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });

  state.faceLandmarkerImage = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { modelAssetPath: FACE_TRACKER_MODEL_URL, delegate: "GPU" },
    runningMode: "IMAGE",
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
  setTrackingStatus("关键点跟踪已就绪");
}

async function api(path, method = "GET", payload) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }
  return response.json();
}

function loadImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function normalizeSketchPoints() {
  if (!state.canvas) return [];
  return getAllSketchPoints().map((point) => {
    const imagePoint = stagePointToImagePoint(point, els.stage, state.canvas.width, state.canvas.height);
    return {
      x: imagePoint.x / state.canvas.width,
      y: imagePoint.y / state.canvas.height,
    };
  });
}

function getSketchBounds(points = normalizeSketchPoints()) {
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(0.04, maxX - minX),
    height: Math.max(0.04, maxY - minY),
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
    },
  };
}

function averagePoints(landmarks, indices) {
  const total = indices.reduce(
    (acc, index) => {
      const point = landmarks[index];
      return { x: acc.x + point.x, y: acc.y + point.y, z: acc.z + point.z };
    },
    { x: 0, y: 0, z: 0 }
  );
  return { x: total.x / indices.length, y: total.y / indices.length, z: total.z / indices.length };
}

function getFaceBasis(landmarks) {
  const leftEye = averagePoints(landmarks, [33, 133, 159, 145]);
  const rightEye = averagePoints(landmarks, [362, 263, 386, 374]);
  const eyeDx = rightEye.x - leftEye.x;
  const eyeDy = rightEye.y - leftEye.y;
  const eyeDistance = Math.max(0.08, Math.hypot(eyeDx, eyeDy));
  const angle = Math.atan2(eyeDy, eyeDx);
  return { leftEye, rightEye, eyeDistance, angle };
}

function detectBindingFromBounds(landmarks, bounds) {
  if (!bounds || !landmarks?.length) return null;
  const { eyeDistance } = getFaceBasis(landmarks);
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  landmarks.forEach((point, index) => {
    const distance = Math.hypot(point.x - bounds.center.x, point.y - bounds.center.y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  const nearestPoint = landmarks[nearestIndex];
  return {
    landmarkIndex: nearestIndex,
    center: bounds.center,
    offset: {
      x: bounds.center.x - nearestPoint.x,
      y: bounds.center.y - nearestPoint.y,
    },
    size: {
      width: bounds.width,
      height: bounds.height,
    },
    baseEyeDistance: eyeDistance,
  };
}

function detectNearestLandmarkBinding() {
  return detectBindingFromBounds(state.initialFaceResult, getSketchBounds());
}

function rotateVector(vector, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  };
}

async function initCanvasWithDataUrl(dataUrl, width, height) {
  const { canvas } = await api("/api/canvas/init", "POST", {
    imageDataUrl: dataUrl,
    width,
    height,
  });
  state.canvas = canvas;
  state.sketchStrokes = [];
  state.currentStroke = null;
  state.currentSticker = null;
  state.lastFaceResult = null;
  state.initialFaceResult = null;
  state.binding = null;
  state.lockedGenerationInputs = null;
  els.baseImage.src = dataUrl;
  els.baseImage.style.display = "block";
  els.cameraFeed.style.display = "none";
  els.stickerPreview.style.display = "none";
  els.previewStage.style.display = "block";
  els.generateButton.disabled = false;
  els.saveSticker.disabled = true;
  els.saveTemplate.disabled = true;
  els.saveCapture.disabled = true;
  renderBindingBadge();
  resizeCanvasToImage();
  updateMeta();
  renderInputImages();
  renderCandidateList();
}

async function initCanvasFromFile(file) {
  const dataUrl = await loadImageAsDataUrl(file);
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  await initCanvasWithDataUrl(dataUrl, image.naturalWidth, image.naturalHeight);
  setStatus("底图已载入。现在在图上画草图，然后点击生成贴图。");
}

async function startCamera() {
  if (state.cameraStream) return;
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    const insecureContext =
      !window.isSecureContext &&
      !["localhost", "127.0.0.1"].includes(window.location.hostname);
    const reason = insecureContext
      ? "当前通过局域网 HTTP 访问，浏览器会禁用摄像头。请改用 localhost、HTTPS，或在浏览器里临时放开不安全来源的摄像头权限。"
      : "当前浏览器环境不支持 mediaDevices.getUserMedia。";
    if (els.multiStartCamera) {
      els.multiStartCamera.textContent = "重新打开摄像头";
    }
    setStatus(`摄像头开启失败：${reason}`);
    setMultiConnectionState(`摄像头开启失败：${reason}`);
    throw new Error(reason);
  }

  try {
    await ensureFaceTrackers();
    state.cameraStream = await mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    syncPreviewFeed();
    els.cameraFeed.style.display = "block";
    startTrackingLoop();
    els.capturePhoto.disabled = false;
    if (els.multiStartCamera) {
      els.multiStartCamera.textContent = "本地视频已开启";
    }
    if (state.multi.roomId && state.multi.remoteUserId) {
      const pc = await ensurePeerConnection();
      state.cameraStream.getTracks().forEach((track) => {
        const exists = pc.getSenders().some((sender) => sender.track === track);
        if (!exists) pc.addTrack(track, state.cameraStream);
      });
    }
    setStatus("摄像头已开启。点击“拍照”进入草图创作。");
  } catch (error) {
    if (els.multiStartCamera) {
      els.multiStartCamera.textContent = "重新打开摄像头";
    }
    setStatus(`摄像头开启失败：${error.message}`);
    setMultiConnectionState(`摄像头开启失败：${error.message}`);
    throw error;
  }
}

function updateMultiRoomUI(room = null) {
  els.multiRoomLabel.textContent = state.multi.roomId || "未创建";
  els.multiRoleLabel.textContent = state.multi.role || "未加入";
  els.multiRemoteLabel.textContent = room?.guest_name || room?.host_name
    ? (state.multi.role === "host" ? (room?.guest_name || "等待加入") : (room?.host_name || "等待加入"))
    : "未加入";
}

async function createRoom() {
  const response = await api("/api/room/create", "POST", { displayName: els.multiDisplayName.value.trim() || "创作者A" });
  state.multi.roomId = response.room.id;
  state.multi.userId = response.userId;
  state.multi.role = response.role;
  els.multiRoomId.value = response.room.id;
  setMultiConnectionState("房间已创建");
  updateMultiRoomUI(response.room);
  startRoomPolling();
  try {
    await startCamera();
  } catch (_) {
    // startCamera already updates visible status text
  }
}

async function joinRoom() {
  const roomId = els.multiRoomId.value.trim();
  if (!roomId) throw new Error("请先输入房间号");
  const response = await api("/api/room/join", "POST", {
    roomId,
    displayName: els.multiDisplayName.value.trim() || "创作者B",
  });
  state.multi.roomId = response.room.id;
  state.multi.userId = response.userId;
  state.multi.role = response.role;
  setMultiConnectionState("已加入房间");
  updateMultiRoomUI(response.room);
  startRoomPolling();
  try {
    await startCamera();
  } catch (_) {
    // startCamera already updates visible status text
  }
}

function stopRoomPolling() {
  if (state.multi.pollTimer) {
    window.clearInterval(state.multi.pollTimer);
    state.multi.pollTimer = null;
  }
}

function showRemoteFrame(frame) {
  state.multi.latestRemoteFrame = frame;
  state.multi.remoteViewMode = frame ? "frame" : "video";
  if (!frame) {
    els.multiRemoteFrame.style.display = "none";
    els.multiRemoteFrame.removeAttribute("src");
    els.multiRemoteSketchLayer.style.display = "none";
    els.multiRemoteVideo.style.display = state.multi.remoteStream ? "block" : "none";
    if (state.multi.remoteStream) {
      els.multiRemoteVideo.play().catch(() => {});
    }
    clearMultiRemoteSketch();
    return;
  }
  els.multiRemoteStickerPreview.style.display = "none";
  els.multiRemoteFrame.src = frame.imageDataUrl;
  els.multiRemoteVideo.pause?.();
  els.multiRemoteFrame.style.display = "block";
  els.multiRemoteVideo.style.display = "none";
  els.multiRemoteSketchLayer.style.display = "block";
  clearMultiRemoteSketch();
  queueMicrotask(() => resizeMultiRemoteSketchLayer());
}

function backToRemoteVideo() {
  state.multi.remoteViewMode = "video";
  els.multiRemoteFrame.style.display = "none";
  els.multiRemoteSketchLayer.style.display = "none";
  clearMultiRemoteSketch(true);
  if (state.multi.remoteStream) {
    els.multiRemoteVideo.style.display = "block";
    els.multiRemoteVideo.play().catch(() => {});
  }
  if (state.multi.remoteSticker) {
    els.multiRemoteStickerPreview.style.display = "block";
    repositionMultiRemoteSticker();
  }
  setMultiConnectionState("?????????");
}

async function pollRoomState() {
  if (!state.multi.roomId || !state.multi.userId) return;
  const response = await api(`/api/room/poll?roomId=${encodeURIComponent(state.multi.roomId)}&userId=${encodeURIComponent(state.multi.userId)}`);
  state.multi.remoteUserId = response.remoteUserId || "";
  updateMultiRoomUI(response.room);
  if (response.remoteFrame) {
    if (response.remoteFrame.frameId !== state.multi.latestRemoteFrame?.frameId) {
      setMultiConnectionState("?????????????????????????");
    }
  } else {
    setMultiConnectionState("???????????????");
  }
  if (response.signals?.length) {
    for (const signal of response.signals) {
      await handleIncomingSignal(signal);
    }
  }
  if (response.incomingStickers?.length) {
    await applyIncomingSticker(response.incomingStickers.at(-1));
  }
}

function startRoomPolling() {
  stopRoomPolling();
  pollRoomState().catch((error) => setMultiConnectionState(`房间轮询失败：${error.message}`));
  state.multi.pollTimer = window.setInterval(() => {
    pollRoomState().catch((error) => setMultiConnectionState(`房间轮询失败：${error.message}`));
  }, 3000);
}

async function captureCurrentVideoFrame(videoEl) {
  if (!videoEl.videoWidth || !videoEl.videoHeight) {
    throw new Error("当前视频还没有可用画面");
  }
  const canvas = document.createElement("canvas");
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const context = canvas.getContext("2d");
  context.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return {
    imageDataUrl: canvas.toDataURL("image/jpeg", 0.92),
    width: canvas.width,
    height: canvas.height,
  };
}

function getBoundsFromPoints(points) {
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(0.04, maxX - minX),
    height: Math.max(0.04, maxY - minY),
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
    },
  };
}

function getRemoteSketchBounds() {
  if (!state.multi.latestRemoteFrame) return null;
  const points = state.multi.remoteSketchStrokes.flatMap((stroke) =>
    stroke.points.map((point) => {
      const mapped = stagePointToImagePoint(
        point,
        els.multiRemoteStage,
        state.multi.latestRemoteFrame.width,
        state.multi.latestRemoteFrame.height
      );
      return {
        x: mapped.x / state.multi.latestRemoteFrame.width,
        y: mapped.y / state.multi.latestRemoteFrame.height,
      };
    })
  );
  return getBoundsFromPoints(points);
}

function drawMultiRemoteSketchToContext(targetCtx, targetWidth, targetHeight) {
  if (!state.multi.remoteSketchStrokes.length) return;
  const layout = getCoverLayout(els.multiRemoteStage, targetWidth, targetHeight);
  targetCtx.lineWidth = Math.max(4, 6 / layout.scale);
  targetCtx.lineCap = "round";
  targetCtx.lineJoin = "round";
  state.multi.remoteSketchStrokes.forEach((stroke) => {
    if (!stroke.points.length) return;
    targetCtx.strokeStyle = stroke.color;
    targetCtx.beginPath();
    stroke.points.forEach((point, index) => {
      const mapped = stagePointToImagePoint(point, els.multiRemoteStage, targetWidth, targetHeight);
      if (index === 0) targetCtx.moveTo(mapped.x, mapped.y);
      else targetCtx.lineTo(mapped.x, mapped.y);
    });
    targetCtx.stroke();
  });
}

async function buildMultiRemoteSketchOnlyImage() {
  const frameImage = new Image();
  frameImage.src = state.multi.latestRemoteFrame.imageDataUrl;
  await frameImage.decode();
  const sketchCanvas = document.createElement("canvas");
  sketchCanvas.width = frameImage.naturalWidth;
  sketchCanvas.height = frameImage.naturalHeight;
  const sketchCtx = sketchCanvas.getContext("2d");
  drawMultiRemoteSketchToContext(sketchCtx, sketchCanvas.width, sketchCanvas.height);
  return sketchCanvas.toDataURL("image/png");
}

async function buildMultiRemoteReferenceImage() {
  const frameImage = new Image();
  frameImage.src = state.multi.latestRemoteFrame.imageDataUrl;
  await frameImage.decode();
  const composedCanvas = document.createElement("canvas");
  composedCanvas.width = frameImage.naturalWidth;
  composedCanvas.height = frameImage.naturalHeight;
  const composedCtx = composedCanvas.getContext("2d");
  composedCtx.drawImage(frameImage, 0, 0, composedCanvas.width, composedCanvas.height);
  drawMultiRemoteSketchToContext(composedCtx, composedCanvas.width, composedCanvas.height);
  return composedCanvas.toDataURL("image/png");
}

async function generateRemoteSticker() {
  if (!state.multi.latestRemoteFrame) throw new Error("请先拉取对方当前画面");
  if (!state.multi.remoteSketchStrokes.length) throw new Error("请先在对方画面上画草图");
  setMultiConnectionState("正在为对方生成贴图...");
  const [referenceImageDataUrl, sketchImageDataUrl] = await Promise.all([
    buildMultiRemoteReferenceImage(),
    buildMultiRemoteSketchOnlyImage(),
  ]);
  const generated = await api("/api/stickers/generate", "POST", {
    sourceImages: [referenceImageDataUrl, sketchImageDataUrl],
  });
  const postprocessed = await api("/api/stickers/postprocess", "POST", { sticker: generated.sticker });
  const remoteFaceResult = await detectFaceLandmarksOnDataUrl(state.multi.latestRemoteFrame.imageDataUrl);
  const remoteBinding = detectBindingFromBounds(remoteFaceResult, getRemoteSketchBounds());
  if (!remoteFaceResult || !remoteBinding) {
    throw new Error("未能从对方冻结帧中识别到可挂载的人脸位置");
  }
  state.multi.remoteSticker = postprocessed.sticker;
  state.multi.remoteSticker.image_data_urls = await Promise.all(
    (state.multi.remoteSticker.image_data_urls || [state.multi.remoteSticker.image_data_url]).map((candidateUrl) =>
      normalizeStickerTransparency(candidateUrl)
    )
  );
  state.multi.remoteSticker.image_data_url = state.multi.remoteSticker.image_data_urls[0];
  state.multi.remoteBinding = remoteBinding;
  state.multi.remoteInitialFaceResult = remoteFaceResult;
  renderMultiRemoteCandidateList();
  setMultiConnectionState(`已为对方生成 ${state.multi.remoteSticker.image_data_urls.length} 张候选贴图`);
}

async function sendCurrentFrameToRoom() {
  if (!state.multi.roomId || !state.multi.userId) throw new Error("请先创建或加入房间");
  if (!state.cameraStream) await startCamera();
  const frame = await captureCurrentVideoFrame(els.multiLocalVideo);
  await api("/api/room/frame/upload", "POST", {
    roomId: state.multi.roomId,
    userId: state.multi.userId,
    ...frame,
  });
  setMultiConnectionState("当前画面已发送");
}

async function startRealtimeVideo() {
  if (!state.multi.roomId || !state.multi.remoteUserId) throw new Error("请先让对方加入房间");
  if (!state.cameraStream) await startCamera();
  await ensurePeerConnection();
  setMultiConnectionState("正在发起实时视频连接...");
}

async function refreshRemoteFrame() {
  if (!state.multi.roomId || !state.multi.remoteUserId) throw new Error("对方还未加入或尚未发送画面");
  const response = await api(`/api/room/frame/latest?roomId=${encodeURIComponent(state.multi.roomId)}&targetUserId=${encodeURIComponent(state.multi.remoteUserId)}`);
  showRemoteFrame(response.frame);
  setMultiConnectionState("已拉取对方最新画面");
}

async function captureFromCamera() {
  if (!state.cameraStream) await startCamera();
  const video = els.cameraFeed;
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("摄像头画面还没准备好");
  }
  const captureCanvas = document.createElement("canvas");
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  captureCanvas.getContext("2d").drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  const dataUrl = captureCanvas.toDataURL("image/png");
  await initCanvasWithDataUrl(dataUrl, captureCanvas.width, captureCanvas.height);
  setStatus("拍照成功。现在在底图上画草图，系统会按草图真实位置绑定跟踪点。");
}

async function saveSketch() {
  if (!state.canvas) return;
  const points = normalizeSketchPoints().map((point) => ({
    x: Math.round(point.x * state.canvas.width),
    y: Math.round(point.y * state.canvas.height),
  }));
  state.canvas = (await api("/api/canvas/sketch", "POST", { canvasId: state.canvas.id, points })).canvas;
}

async function detectInitialFaceOnBaseImage() {
  await ensureFaceTrackers();
  if (!els.baseImage.complete) await els.baseImage.decode();
  const result = state.faceLandmarkerImage.detect(els.baseImage);
  state.initialFaceResult = result?.faceLandmarks?.[0] || null;
}

async function detectFaceLandmarksOnDataUrl(dataUrl) {
  await ensureFaceTrackers();
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const result = state.faceLandmarkerImage.detect(image);
  return result?.faceLandmarks?.[0] || null;
}

async function generateSticker() {
  if (!state.canvas) return;
  await saveSketch();
  await detectInitialFaceOnBaseImage();
  state.binding = detectNearestLandmarkBinding();
  renderBindingBadge();
  if (state.binding) {
    setTrackingStatus(`草图已绑定到 landmark #${state.binding.landmarkIndex}`);
  } else {
    setTrackingStatus("未检测到初始人脸，生成后将按静态位置显示");
  }

  setStatus("正在用草图直接生成贴图，底图仅用于绑定和实时跟踪...");
  if (!state.lockedGenerationInputs) {
    state.lockedGenerationInputs = {
      referenceImageDataUrl: await buildReferenceImage(),
      sketchImageDataUrl: await buildSketchOnlyImage(),
    };
  }
  const { sketchImageDataUrl } = state.lockedGenerationInputs;
  renderInputImages(sketchImageDataUrl);
  const generated = await api("/api/stickers/generate", "POST", {
    canvasId: state.canvas.id,
    sourceImages: [sketchImageDataUrl],
  });
  const postprocessed = await api("/api/stickers/postprocess", "POST", { sticker: generated.sticker });
  state.currentSticker = postprocessed.sticker;
  state.currentSticker.image_data_urls = await Promise.all(
    (state.currentSticker.image_data_urls || [state.currentSticker.image_data_url]).map((candidateUrl) =>
      normalizeStickerTransparency(candidateUrl)
    )
  );
  state.currentSticker.image_data_url = state.currentSticker.image_data_urls[0];
  els.stickerPreview.src = state.currentSticker.image_data_url;
  els.stickerPreview.style.display = "block";
  els.previewStage.style.display = "block";
  repositionSticker();
  updateMeta();
  renderCandidateList();
  els.saveSticker.disabled = false;
  els.saveTemplate.disabled = false;
  els.saveCapture.disabled = false;
  setStatus(`贴图已生成，共返回 ${state.currentSticker.image_data_urls.length} 张候选图。选择一张后会用于预览和保存。`);
}

async function normalizeStickerTransparency(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = imageData.data;
      for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        const a = pixels[index + 3];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const isNearBlack = max < 28;
        const isDarkGray = max < 45 && max - min < 16;
        if (a > 0 && (isNearBlack || isDarkGray)) {
          pixels[index + 3] = 0;
        }
      }
      context.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

async function buildSketchOnlyImage() {
  const sketchCanvas = document.createElement("canvas");
  sketchCanvas.width = state.canvas.width;
  sketchCanvas.height = state.canvas.height;
  const sketchCtx = sketchCanvas.getContext("2d");
  sketchCtx.clearRect(0, 0, sketchCanvas.width, sketchCanvas.height);
  drawSketchStrokesToContext(sketchCtx, sketchCanvas.width, sketchCanvas.height);
  return sketchCanvas.toDataURL("image/png");
}

async function buildReferenceImage() {
  const composedCanvas = document.createElement("canvas");
  composedCanvas.width = state.canvas.width;
  composedCanvas.height = state.canvas.height;
  const composedCtx = composedCanvas.getContext("2d");
  const base = new Image();
  base.src = els.baseImage.src;
  await base.decode();
  composedCtx.drawImage(base, 0, 0, composedCanvas.width, composedCanvas.height);
  drawSketchStrokesToContext(composedCtx, composedCanvas.width, composedCanvas.height);
  return composedCanvas.toDataURL("image/png");
}

function positionStickerFallback() {
  if (!state.currentSticker) return;
  const sticker = els.stickerPreview;
  const bounds = getSketchBounds() || { center: { x: 0.5, y: 0.3 }, width: 0.18, height: 0.18 };
  const previewSource = getPreviewSourceDimensions();
  const centerPoint = imagePointToStagePoint(
    {
      x: bounds.center.x * previewSource.width,
      y: bounds.center.y * previewSource.height,
    },
    els.previewStage,
    previewSource.width,
    previewSource.height
  );
  const stickerWidth = Math.max(72, bounds.width * previewSource.width * centerPoint.scale * 1.5);
  const ratio = (state.currentSticker.height || 1) / Math.max(state.currentSticker.width || 1, 1);
  const stickerHeight = stickerWidth * ratio;
  const verticalLift = stickerHeight * 0.14;
  sticker.style.width = `${stickerWidth}px`;
  sticker.style.height = "auto";
  sticker.style.left = `${centerPoint.x - stickerWidth / 2}px`;
  sticker.style.top = `${centerPoint.y - stickerHeight / 2 - verticalLift}px`;
  sticker.style.transform = "rotate(0deg)";
}

function positionStickerFromBinding(faceLandmarks) {
  if (!state.currentSticker || !state.binding) return;
  const sticker = els.stickerPreview;
  const basis = getFaceBasis(faceLandmarks);
  const initialBasis = getFaceBasis(state.initialFaceResult);
  const scaleRatio = basis.eyeDistance / initialBasis.eyeDistance;
  const angleDelta = basis.angle - initialBasis.angle;
  const trackedLandmark = faceLandmarks[state.binding.landmarkIndex];
  const rotatedOffset = rotateVector(
    {
      x: state.binding.offset.x * scaleRatio,
      y: state.binding.offset.y * scaleRatio,
    },
    angleDelta
  );
  const center = {
    x: trackedLandmark.x + rotatedOffset.x,
    y: trackedLandmark.y + rotatedOffset.y,
  };
  const previewSource = getPreviewSourceDimensions();
  const centerPoint = imagePointToStagePoint(
    {
      x: center.x * previewSource.width,
      y: center.y * previewSource.height,
    },
    els.previewStage,
    previewSource.width,
    previewSource.height
  );
  const stickerWidth = Math.max(72, state.binding.size.width * previewSource.width * centerPoint.scale * scaleRatio * 1.5);
  const ratio = (state.currentSticker.height || 1) / Math.max(state.currentSticker.width || 1, 1);
  const stickerHeight = Math.max(72, stickerWidth * ratio);
  const verticalLift = stickerHeight * 0.14;
  sticker.style.width = `${stickerWidth}px`;
  sticker.style.height = "auto";
  sticker.style.left = `${centerPoint.x - stickerWidth / 2}px`;
  sticker.style.top = `${centerPoint.y - stickerHeight / 2 - verticalLift}px`;
  sticker.style.transform = `rotate(${(angleDelta * 180 / Math.PI).toFixed(2)}deg)`;
}

function repositionSticker() {
  if (!state.currentSticker) return;
  if (!state.staticMode && state.lastFaceResult && state.binding && state.initialFaceResult) {
    positionStickerFromBinding(state.lastFaceResult);
  } else {
    positionStickerFallback();
  }
}

function positionMultiRemoteStickerFallback() {
  if (!state.multi.remoteSticker || !state.multi.remoteBinding) return;
  const sticker = els.multiRemoteStickerPreview;
  const previewSource = {
    width: els.multiRemoteVideo.videoWidth || state.multi.latestRemoteFrame?.width || 1,
    height: els.multiRemoteVideo.videoHeight || state.multi.latestRemoteFrame?.height || 1,
  };
  const centerPoint = imagePointToStagePoint(
    {
      x: state.multi.remoteBinding.center.x * previewSource.width,
      y: state.multi.remoteBinding.center.y * previewSource.height,
    },
    els.multiRemoteStage,
    previewSource.width,
    previewSource.height
  );
  const stickerWidth = Math.max(72, state.multi.remoteBinding.size.width * previewSource.width * centerPoint.scale * 1.5);
  const ratio = (state.multi.remoteSticker.height || 1) / Math.max(state.multi.remoteSticker.width || 1, 1);
  const stickerHeight = stickerWidth * ratio;
  const verticalLift = stickerHeight * 0.14;
  sticker.style.width = `${stickerWidth}px`;
  sticker.style.height = "auto";
  sticker.style.left = `${centerPoint.x - stickerWidth / 2}px`;
  sticker.style.top = `${centerPoint.y - stickerHeight / 2 - verticalLift}px`;
  sticker.style.transform = "rotate(0deg)";
}

function positionMultiRemoteStickerFromBinding(faceLandmarks) {
  if (!state.multi.remoteSticker || !state.multi.remoteBinding || !state.multi.remoteInitialFaceResult) return;
  const sticker = els.multiRemoteStickerPreview;
  const basis = getFaceBasis(faceLandmarks);
  const initialBasis = getFaceBasis(state.multi.remoteInitialFaceResult);
  const scaleRatio = basis.eyeDistance / initialBasis.eyeDistance;
  const angleDelta = basis.angle - initialBasis.angle;
  const trackedLandmark = faceLandmarks[state.multi.remoteBinding.landmarkIndex];
  const rotatedOffset = rotateVector(
    {
      x: state.multi.remoteBinding.offset.x * scaleRatio,
      y: state.multi.remoteBinding.offset.y * scaleRatio,
    },
    angleDelta
  );
  const center = {
    x: trackedLandmark.x + rotatedOffset.x,
    y: trackedLandmark.y + rotatedOffset.y,
  };
  const previewSource = {
    width: els.multiRemoteVideo.videoWidth || state.multi.latestRemoteFrame?.width || 1,
    height: els.multiRemoteVideo.videoHeight || state.multi.latestRemoteFrame?.height || 1,
  };
  const centerPoint = imagePointToStagePoint(
    {
      x: center.x * previewSource.width,
      y: center.y * previewSource.height,
    },
    els.multiRemoteStage,
    previewSource.width,
    previewSource.height
  );
  const stickerWidth = Math.max(
    72,
    state.multi.remoteBinding.size.width * previewSource.width * centerPoint.scale * scaleRatio * 1.5
  );
  const ratio = (state.multi.remoteSticker.height || 1) / Math.max(state.multi.remoteSticker.width || 1, 1);
  const stickerHeight = Math.max(72, stickerWidth * ratio);
  const verticalLift = stickerHeight * 0.14;
  sticker.style.width = `${stickerWidth}px`;
  sticker.style.height = "auto";
  sticker.style.left = `${centerPoint.x - stickerWidth / 2}px`;
  sticker.style.top = `${centerPoint.y - stickerHeight / 2 - verticalLift}px`;
  sticker.style.transform = `rotate(${(angleDelta * 180 / Math.PI).toFixed(2)}deg)`;
}

function repositionMultiRemoteSticker(faceLandmarks = null) {
  if (!state.multi.remoteSticker) return;
  if (faceLandmarks && state.multi.remoteBinding && state.multi.remoteInitialFaceResult) {
    positionMultiRemoteStickerFromBinding(faceLandmarks);
  } else {
    positionMultiRemoteStickerFallback();
  }
}

function positionMultiIncomingStickerFallback() {
  if (!state.multi.incomingSticker || !state.multi.incomingBinding) return;
  const sticker = els.multiLocalStickerPreview;
  const previewSource = {
    width: els.multiLocalVideo.videoWidth || els.previewFeed.videoWidth || 1,
    height: els.multiLocalVideo.videoHeight || els.previewFeed.videoHeight || 1,
  };
  const centerPoint = imagePointToStagePoint(
    {
      x: state.multi.incomingBinding.center.x * previewSource.width,
      y: state.multi.incomingBinding.center.y * previewSource.height,
    },
    els.multiLocalStage,
    previewSource.width,
    previewSource.height
  );
  const stickerWidth = Math.max(72, state.multi.incomingBinding.size.width * previewSource.width * centerPoint.scale * 1.5);
  const ratio = (state.multi.incomingSticker.height || 1) / Math.max(state.multi.incomingSticker.width || 1, 1);
  const stickerHeight = stickerWidth * ratio;
  const verticalLift = stickerHeight * 0.14;
  sticker.style.width = `${stickerWidth}px`;
  sticker.style.height = "auto";
  sticker.style.left = `${centerPoint.x - stickerWidth / 2}px`;
  sticker.style.top = `${centerPoint.y - stickerHeight / 2 - verticalLift}px`;
  sticker.style.transform = "rotate(0deg)";
}

function positionMultiIncomingStickerFromBinding(faceLandmarks) {
  if (!state.multi.incomingSticker || !state.multi.incomingBinding || !state.multi.incomingInitialFaceResult) return;
  const sticker = els.multiLocalStickerPreview;
  const basis = getFaceBasis(faceLandmarks);
  const initialBasis = getFaceBasis(state.multi.incomingInitialFaceResult);
  const scaleRatio = basis.eyeDistance / initialBasis.eyeDistance;
  const angleDelta = basis.angle - initialBasis.angle;
  const trackedLandmark = faceLandmarks[state.multi.incomingBinding.landmarkIndex];
  const rotatedOffset = rotateVector(
    {
      x: state.multi.incomingBinding.offset.x * scaleRatio,
      y: state.multi.incomingBinding.offset.y * scaleRatio,
    },
    angleDelta
  );
  const center = {
    x: trackedLandmark.x + rotatedOffset.x,
    y: trackedLandmark.y + rotatedOffset.y,
  };
  const previewSource = {
    width: els.multiLocalVideo.videoWidth || els.previewFeed.videoWidth || 1,
    height: els.multiLocalVideo.videoHeight || els.previewFeed.videoHeight || 1,
  };
  const centerPoint = imagePointToStagePoint(
    {
      x: center.x * previewSource.width,
      y: center.y * previewSource.height,
    },
    els.multiLocalStage,
    previewSource.width,
    previewSource.height
  );
  const stickerWidth = Math.max(
    72,
    state.multi.incomingBinding.size.width * previewSource.width * centerPoint.scale * scaleRatio * 1.5
  );
  const ratio = (state.multi.incomingSticker.height || 1) / Math.max(state.multi.incomingSticker.width || 1, 1);
  const stickerHeight = Math.max(72, stickerWidth * ratio);
  const verticalLift = stickerHeight * 0.14;
  sticker.style.width = `${stickerWidth}px`;
  sticker.style.height = "auto";
  sticker.style.left = `${centerPoint.x - stickerWidth / 2}px`;
  sticker.style.top = `${centerPoint.y - stickerHeight / 2 - verticalLift}px`;
  sticker.style.transform = `rotate(${(angleDelta * 180 / Math.PI).toFixed(2)}deg)`;
}

function repositionMultiIncomingSticker() {
  if (!state.multi.incomingSticker) return;
  if (state.lastFaceResult && state.multi.incomingBinding && state.multi.incomingInitialFaceResult) {
    positionMultiIncomingStickerFromBinding(state.lastFaceResult);
  } else {
    positionMultiIncomingStickerFallback();
  }
}

async function sendSelectedRemoteSticker() {
  if (!state.multi.roomId || !state.multi.userId || !state.multi.remoteUserId) throw new Error("请先让对方加入房间");
  if (!state.multi.remoteSticker || !state.multi.remoteBinding || !state.multi.remoteInitialFaceResult) {
    throw new Error("请先给对方生成候选贴图");
  }
  await api("/api/room/sticker/send", "POST", {
    roomId: state.multi.roomId,
    fromUserId: state.multi.userId,
    toUserId: state.multi.remoteUserId,
    sticker: state.multi.remoteSticker,
    binding: state.multi.remoteBinding,
    initialFaceResult: state.multi.remoteInitialFaceResult,
  });
  els.multiRemoteStickerPreview.src = state.multi.remoteSticker.image_data_url;
  els.multiRemoteStickerPreview.style.display = "block";
  backToRemoteVideo();
  repositionMultiRemoteSticker();
  setMultiConnectionState("当前候选贴图已发给对方，等待对方本地挂载");
}

async function applyIncomingSticker(message) {
  state.multi.incomingSticker = message.sticker;
  state.multi.incomingBinding = message.binding;
  state.multi.incomingInitialFaceResult = message.initialFaceResult;
  els.multiLocalStickerPreview.src = state.multi.incomingSticker.image_data_url;
  els.multiLocalStickerPreview.style.display = "block";
  repositionMultiIncomingSticker();
  setMultiConnectionState("已收到对方发来的贴图，并挂载到本地视频");
}

function startTrackingLoop() {
  if (state.trackingLoopStarted) return;
  state.trackingLoopStarted = true;
  const loop = () => {
    if (!state.faceLandmarkerVideo || !state.cameraStream) {
      requestAnimationFrame(loop);
      return;
    }
    const video = els.previewFeed;
    if (video.readyState >= 2 && video.currentTime !== state.lastTrackedVideoTime) {
      try {
        const result = state.faceLandmarkerVideo.detectForVideo(video, performance.now());
        if (result?.faceLandmarks?.length) {
          state.lastFaceResult = result.faceLandmarks[0];
          if (!state.staticMode && state.currentSticker && state.binding) {
            positionStickerFromBinding(state.lastFaceResult);
            setTrackingStatus(`?????????landmark #${state.binding.landmarkIndex}`);
          } else {
            setTrackingStatus("??????");
          }
          if (state.multi.incomingSticker) {
            repositionMultiIncomingSticker();
          }
        } else if (!state.staticMode && state.currentSticker) {
          positionStickerFallback();
          setTrackingStatus("??????????????");
        } else if (state.multi.incomingSticker) {
          positionMultiIncomingStickerFallback();
        }
      } catch (error) {
        setTrackingStatus(`?????${error.message}`);
      }
      state.lastTrackedVideoTime = video.currentTime;
    }

    const remoteVideo = els.multiRemoteVideo;
    if (
      state.multi.remoteSticker &&
      state.multi.remoteViewMode === "video" &&
      remoteVideo.readyState >= 2 &&
      remoteVideo.currentTime !== state.multi.lastRemoteTrackedVideoTime
    ) {
      try {
        const remoteResult = state.faceLandmarkerVideo.detectForVideo(remoteVideo, performance.now() + 1);
        if (remoteResult?.faceLandmarks?.length) {
          repositionMultiRemoteSticker(remoteResult.faceLandmarks[0]);
        } else {
          positionMultiRemoteStickerFallback();
        }
      } catch (_) {
        positionMultiRemoteStickerFallback();
      }
      state.multi.lastRemoteTrackedVideoTime = remoteVideo.currentTime;
    }

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function clearSketch() {
  state.sketchStrokes = [];
  state.currentStroke = null;
  state.lockedGenerationInputs = null;
  redrawSketch();
  renderInputImages();
  setStatus("草图已清空。重新绘制后可再次生成贴图。");
}

function makeTile({ title, description, preview, actionText, onClick }) {
  const tile = document.createElement("div");
  tile.className = "tile";
  if (preview) {
    const img = document.createElement("img");
    img.src = preview;
    img.alt = title;
    tile.appendChild(img);
  }
  const h3 = document.createElement("h3");
  h3.textContent = title;
  tile.appendChild(h3);
  const p = document.createElement("p");
  p.textContent = description;
  tile.appendChild(p);
  if (actionText) {
    const button = document.createElement("button");
    button.textContent = actionText;
    button.style.marginTop = "10px";
    button.addEventListener("click", onClick);
    tile.appendChild(button);
  }
  return tile;
}

async function loadAssets() {
  const [{ templates: discover }, { templates: mineTemplates }, { assets }] = await Promise.all([
    api("/api/templates/discover"),
    api("/api/templates/mine"),
    api("/api/assets/mine"),
  ]);

  els.discoverList.innerHTML = "";
  discover.forEach((item) => {
    const preview = `data:image/svg+xml;base64,${btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="260"><rect width="320" height="260" rx="24" fill="${item.preview_color}22"/><circle cx="160" cy="82" r="42" fill="${item.preview_color}55"/><rect x="88" y="148" width="144" height="58" rx="28" fill="${item.preview_color}"/></svg>`
    )}`;
    els.discoverList.appendChild(
      makeTile({
        title: item.name,
        description: item.description,
        preview,
        actionText: "跳转到 Tab1",
        onClick: () => {
          switchTab("create");
          setStatus(`已从发现页进入 "${item.name}"。上传底图并开始草图创作。`);
        },
      })
    );
  });

  els.mineTemplates.innerHTML = "";
  if (!mineTemplates.length) {
    els.mineTemplates.appendChild(makeTile({ title: "暂无模板", description: "保存模板后会展示在这里。" }));
  } else {
    mineTemplates
      .slice()
      .reverse()
      .forEach((item) => {
        els.mineTemplates.appendChild(
          makeTile({
            title: item.name,
            description: item.anchor || "模板",
            preview: item.preview_url,
          })
        );
      });
  }

  els.mineAssets.innerHTML = "";
  if (!assets.length) {
    els.mineAssets.appendChild(makeTile({ title: "暂无资产", description: "保存贴图或照片后会展示在这里。" }));
  } else {
    assets
      .slice()
      .reverse()
      .forEach((item) => {
        els.mineAssets.appendChild(
          makeTile({
            title: item.kind === "capture" ? "拍摄成品" : "已保存贴图",
            description: item.kind === "capture" ? item.capture_type || "image" : item.recommended_anchor || "sticker",
            preview: item.url || item.image_url,
          })
        );
      });
  }
}

async function saveSticker() {
  if (!state.currentSticker || !state.canvas) return;
  await api("/api/assets/save-sticker", "POST", { canvasId: state.canvas.id, sticker: state.currentSticker });
  setStatus("贴图已保存到资产库。");
  await loadAssets();
}

async function saveTemplate() {
  if (!state.currentSticker) return;
  await api("/api/templates/save", "POST", {
    name: `模板 ${new Date().toLocaleTimeString()}`,
    sticker: state.currentSticker,
  });
  setStatus("模板已保存到“我的”。");
  await loadAssets();
}

async function saveCapture() {
  if (!state.canvas) return;
  const captureCanvas = document.createElement("canvas");
  captureCanvas.width = state.canvas.width;
  captureCanvas.height = state.canvas.height;
  const captureCtx = captureCanvas.getContext("2d");
  const video = els.previewFeed;
  if (video.videoWidth && video.videoHeight) {
    captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  } else {
    const base = new Image();
    base.src = els.baseImage.src;
    await base.decode();
    captureCtx.drawImage(base, 0, 0, captureCanvas.width, captureCanvas.height);
  }
  if (state.currentSticker) {
    const sticker = new Image();
    sticker.src = state.currentSticker.image_data_url;
    await sticker.decode();
    const stageRect = els.previewStage.getBoundingClientRect();
    const stickerWidth = parseFloat(els.stickerPreview.style.width);
    const stickerHeight = stickerWidth * (state.currentSticker.height / state.currentSticker.width);
    const x = (parseFloat(els.stickerPreview.style.left) / stageRect.width) * captureCanvas.width;
    const y = (parseFloat(els.stickerPreview.style.top) / stageRect.height) * captureCanvas.height;
    const w = (stickerWidth / stageRect.width) * captureCanvas.width;
    const h = (stickerHeight / stageRect.height) * captureCanvas.height;
    captureCtx.save();
    const rotateDeg = els.stickerPreview.style.transform.match(/-?\d+(\.\d+)?/);
    const angle = rotateDeg ? (parseFloat(rotateDeg[0]) * Math.PI) / 180 : 0;
    captureCtx.translate(x + w / 2, y + h / 2);
    captureCtx.rotate(angle);
    captureCtx.drawImage(sticker, -w / 2, -h / 2, w, h);
    captureCtx.restore();
  }
  await api("/api/captures/save", "POST", {
    captureDataUrl: captureCanvas.toDataURL("image/png"),
    captureType: "image",
  });
  setStatus("照片成品已保存。");
  await loadAssets();
}

function getPointerPoint(event) {
  const rect = els.sketchLayer.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function bindSketchInput() {
  let drawing = false;
  const start = (event) => {
    if (!state.canvas) return;
    drawing = true;
    state.currentStroke = { color: state.brushColor, points: [getPointerPoint(event)] };
    state.sketchStrokes.push(state.currentStroke);
    redrawSketch();
  };
  const move = (event) => {
    if (!drawing || !state.currentStroke) return;
    state.currentStroke.points.push(getPointerPoint(event));
    redrawSketch();
  };
  const end = () => {
    if (!drawing) return;
    drawing = false;
    state.currentStroke = null;
    if (state.sketchStrokes.length) {
      setStatus("草图已更新。生成时会按草图真实位置自动绑定跟踪点。");
    }
  };
  els.sketchLayer.addEventListener("pointerdown", start);
  els.sketchLayer.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
}

function bindMultiRemoteSketchInput() {
  let drawing = false;
  const start = (event) => {
    if (!state.multi.latestRemoteFrame) return;
    drawing = true;
    state.multi.currentRemoteStroke = { color: state.brushColor, points: [getMultiRemotePointerPoint(event)] };
    state.multi.remoteSketchStrokes.push(state.multi.currentRemoteStroke);
    redrawMultiRemoteSketch();
  };
  const move = (event) => {
    if (!drawing || !state.multi.currentRemoteStroke) return;
    state.multi.currentRemoteStroke.points.push(getMultiRemotePointerPoint(event));
    redrawMultiRemoteSketch();
  };
  const end = () => {
    if (!drawing) return;
    drawing = false;
    state.multi.currentRemoteStroke = null;
    if (state.multi.remoteSketchStrokes.length) {
      setMultiConnectionState("已在对方冻结帧上完成草图，可以直接生成贴图");
    }
  };
  els.multiRemoteSketchLayer.addEventListener("pointerdown", start);
  els.multiRemoteSketchLayer.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("resize", resizeMultiRemoteSketchLayer);
}

function bindEvents() {
  els.tabs.forEach((tabEl) => tabEl.addEventListener("click", () => switchTab(tabEl.dataset.tab)));
  els.capturePhoto.addEventListener("click", async () => {
    try {
      await captureFromCamera();
    } catch (error) {
      setStatus(`拍照失败：${error.message}`);
    }
  });
  els.clearSketch.addEventListener("click", clearSketch);
  els.generateButton.addEventListener("click", async () => {
    setGenerationOverlay(true);
    try {
      await generateSticker();
    } catch (error) {
      setStatus(`生成失败：${error.message}`);
    } finally {
      setGenerationOverlay(false);
    }
  });
  els.saveSticker.addEventListener("click", async () => {
    try {
      await saveSticker();
    } catch (error) {
      setStatus(`保存贴图失败：${error.message}`);
    }
  });
  els.saveTemplate.addEventListener("click", async () => {
    try {
      await saveTemplate();
    } catch (error) {
      setStatus(`保存模板失败：${error.message}`);
    }
  });
  els.saveCapture.addEventListener("click", async () => {
    try {
      await saveCapture();
    } catch (error) {
      setStatus(`保存成品失败：${error.message}`);
    }
  });
  els.toggleStaticMode.addEventListener("click", () => {
    state.staticMode = !state.staticMode;
    els.toggleStaticMode.textContent = state.staticMode ? "回到跟踪模式" : "静态摆放";
    if (state.staticMode) {
      positionStickerFallback();
      setTrackingStatus("已切到静态摆放");
    } else {
      repositionSticker();
      setTrackingStatus(state.binding ? `实时跟踪草图点位：landmark #${state.binding.landmarkIndex}` : "实时跟踪已恢复");
    }
    updateMeta();
  });
  els.brushHue.addEventListener("input", () => {
    state.brushColor = `hsl(${els.brushHue.value} 90% 58%)`;
    updateBrushPreview();
  });
  els.multiCreateRoom.addEventListener("click", async () => {
    try {
      await createRoom();
    } catch (error) {
      setMultiConnectionState(`创建失败：${error.message}`);
    }
  });
  els.multiJoinRoom.addEventListener("click", async () => {
    try {
      await joinRoom();
    } catch (error) {
      setMultiConnectionState(`加入失败：${error.message}`);
    }
  });
  els.multiCopyRoom.addEventListener("click", async () => {
    if (!els.multiRoomId.value.trim()) return;
    try {
      await navigator.clipboard.writeText(els.multiRoomId.value.trim());
      setMultiConnectionState("房间号已复制");
    } catch (error) {
      setMultiConnectionState(`复制失败：${error.message}`);
    }
  });
  els.multiStartCamera.addEventListener("click", async () => {
    try {
      await startCamera();
      setMultiConnectionState("本地视频已开启");
    } catch (error) {
      setMultiConnectionState(`摄像头失败：${error.message}`);
    }
  });
  els.multiStartRealtime.addEventListener("click", async () => {
    try {
      await startRealtimeVideo();
    } catch (error) {
      setMultiConnectionState(`实时连接失败：${error.message}`);
    }
  });
  els.multiSendFrame.addEventListener("click", async () => {
    try {
      await sendCurrentFrameToRoom();
    } catch (error) {
      setMultiConnectionState(`发送失败：${error.message}`);
    }
  });
  els.multiRefreshFrame.addEventListener("click", async () => {
    try {
      await refreshRemoteFrame();
    } catch (error) {
      setMultiConnectionState(`拉取失败：${error.message}`);
    }
  });
  els.multiBackToVideo.addEventListener("click", () => {
    backToRemoteVideo();
  });
  els.multiClearSketch.addEventListener("click", () => {
    clearMultiRemoteSketch();
    setMultiConnectionState("已清空对方画面上的草图");
  });
  els.multiGenerateSticker.addEventListener("click", async () => {
    setGenerationOverlay(true);
    try {
      await generateRemoteSticker();
    } catch (error) {
      setMultiConnectionState(`给对方生成失败：${error.message}`);
    } finally {
      setGenerationOverlay(false);
    }
  });
  els.multiSendSticker.addEventListener("click", async () => {
    try {
      await sendSelectedRemoteSticker();
    } catch (error) {
      setMultiConnectionState(`发送给对方失败：${error.message}`);
    }
  });
  window.addEventListener("resize", () => {
    resizeCanvasToImage();
    resizeMultiRemoteSketchLayer();
    repositionMultiIncomingSticker();
  });
}

async function init() {
  els.fixedPrompt.textContent = state.fixedPrompt;
  els.previewStage.style.display = "block";
  updateBrushPreview();
  renderBindingBadge();
  renderInputImages();
  renderCandidateList();
  renderMultiRemoteCandidateList();
  updateMultiRoomUI();
  bindSketchInput();
  bindMultiRemoteSketchInput();
  bindEvents();
  updateMeta();
  setTrackingStatus("跟踪器未初始化");
  await loadAssets();
  try {
    await startCamera();
  } catch (error) {
    setStatus(`自动打开摄像头失败：${error.message}`);
  }
}

init();
