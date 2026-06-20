const appState = {
  data: null,
  allSamples: [],
  samples: [],
  selectedSample: null,
  selectedIndex: 0,
  selectedKind: "label",
  objOView: "main",
  dirty: false,
  selectionRenderTimer: null,
  anchorSnapTimer: null,
  anchorSnapBusy: false,
  anchorSnapPending: false,
  objOSource: "input",
  tempObjOStale: true,
  baselineAnnotationPath: "",
  targetBaselines: new Map(),
  undoStack: [],
  redoStack: [],
  pendingHistorySnapshot: null,
  historyRestoring: false,
  historyLimit: 80,
  sampleStatusFilter: "all",
  sampleRatingFilter: "all",
  inputCheck: null,
  logTimer: null,
  logPath: "",
  lastLogText: "",
};

const viewIds = { main: "imgMain", up: "imgUp", down: "imgDown", left: "imgLeft", right: "imgRight" };
const partIds = { main: "partMain", up: "partUp", down: "partDown", left: "partLeft", right: "partRight" };
const guideIds = { main: "guideMain", up: "guideUp", down: "guideDown", left: "guideLeft", right: "guideRight" };
const overlayIds = { main: "overlayMain", up: "overlayUp", down: "overlayDown", left: "overlayLeft", right: "overlayRight" };
const axisInputs = ["camX", "camY", "camZ"];
const sliderIds = ["sliderX", "sliderY", "sliderZ"];
const axisNames = ["x", "y", "z"];
const axisColors = { "+x": "#d94733", "+y": "#2368b8", "+z": "#218354" };
const ratingLabels = { good: "好", medium: "中", bad: "差", unknown: "未知" };
const reviewRatingLabels = { good: "优", medium: "中", bad: "差", unknown: "未知" };
const sampleStatusLabels = {
  "": "待微调",
  adjusted: "已微调待审核",
  changes_required: "已审核待修改",
  reviewed: "已审核为优",
};
const minVisibleMove = 0.12;
const moveTraceMinDistance = 1e-4;
const objOSourceLabels = { input: "输入状态", output: "输出状态", temp: "微调中" };
const viewLabels = { main: "主视角", up: "上视角", down: "下视角", left: "左视角", right: "右视角" };

const $ = (id) => document.getElementById(id);
const pathInputIds = ["datasetRoot", "outputRoot", "annotationPath", "objPath"];

function projectPathDisplay(value) {
  const text = String(value || "");
  const normalized = text.replace(/\//g, "\\");
  const marker = "manual_adjust_app";
  const index = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
  return index >= 0 ? `……\\${normalized.slice(index)}` : normalized;
}

function shortenMiddle(value, maxLength = 56) {
  const text = projectPathDisplay(value);
  if (text.length <= maxLength) return text;
  const marker = "……";
  const projectPrefix = text.match(/^……\\manual_adjust_app(?:\\data)?/i)?.[0] || "";
  if (projectPrefix && projectPrefix.length + 8 < maxLength) {
    const tailLength = Math.max(8, maxLength - projectPrefix.length - marker.length);
    return `${projectPrefix}${marker}${text.slice(text.length - tailLength)}`;
  }
  const keep = Math.max(8, maxLength - marker.length);
  const head = Math.ceil(keep * 0.52);
  const tail = Math.floor(keep * 0.48);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function pathLimitForInput(id) {
  if (id === "annotationPath" || id === "objPath") return 48;
  return 58;
}

function pathInputValue(id) {
  const node = $(id);
  return String(node?.dataset.fullValue ?? node?.value ?? "").trim();
}

function setPathInputValue(id, value) {
  const node = $(id);
  if (!node) return;
  const fullValue = String(value || "");
  node.dataset.fullValue = fullValue;
  node.title = fullValue;
  const shouldShowFull = document.activeElement === node;
  node.value = shouldShowFull ? fullValue : shortenMiddle(fullValue, pathLimitForInput(id));
}

function bindPathInputs() {
  for (const id of pathInputIds) {
    const node = $(id);
    if (!node) continue;
    node.dataset.fullValue = node.value || "";
    node.title = node.dataset.fullValue;
    node.addEventListener("focus", () => {
      node.value = node.dataset.fullValue || "";
    });
    node.addEventListener("input", () => {
      node.dataset.fullValue = node.value;
      node.title = node.value;
    });
    node.addEventListener("blur", () => {
      setPathInputValue(id, node.dataset.fullValue || node.value || "");
    });
  }
}

let mediaModalRestore = null;

function stripElementIds(root) {
  root.removeAttribute?.("id");
  root.querySelectorAll?.("[id]").forEach((node) => node.removeAttribute("id"));
}

function ensureMediaModal() {
  let modal = $("mediaModal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "mediaModal";
  modal.className = "media-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="media-modal-panel" role="dialog" aria-modal="true" aria-labelledby="mediaModalTitle">
      <header class="media-modal-header">
        <button class="media-modal-close" type="button" aria-label="关闭"></button>
        <strong id="mediaModalTitle">预览</strong>
      </header>
      <div class="media-modal-body"></div>
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeMediaModal();
  });
  modal.querySelector(".media-modal-close")?.addEventListener("click", closeMediaModal);
  document.body.appendChild(modal);
  return modal;
}

function closeMediaModal() {
  const modal = $("mediaModal");
  if (!modal) return;
  mediaModalRestore?.();
  mediaModalRestore = null;
  modal.hidden = true;
  modal.querySelector(".media-modal-body").innerHTML = "";
  modal.querySelector(".media-modal-body").className = "media-modal-body";
  document.body.classList.remove("modal-open");
  window.resizeObjOView?.();
}

function openMediaModal(title) {
  const modal = ensureMediaModal();
  modal.querySelector("#mediaModalTitle").textContent = title || "预览";
  modal.hidden = false;
  document.body.classList.add("modal-open");
  return modal.querySelector(".media-modal-body");
}

function openImageModal(card) {
  const headerText = card.querySelector("header")?.childNodes?.[0]?.textContent?.trim() || "投影预览";
  const body = openMediaModal(headerText);
  const frame = card.querySelector(".image-frame");
  if (frame) {
    const clone = frame.cloneNode(true);
    stripElementIds(clone);
    clone.classList.add("modal-image-frame");
    body.appendChild(clone);
  } else {
    const img = card.querySelector("img");
    if (img?.src) {
      const clone = img.cloneNode(true);
      stripElementIds(clone);
      clone.classList.add("modal-image");
      body.appendChild(clone);
    } else {
      body.textContent = "当前没有可放大的图像。";
    }
  }
}

function openObjModal(card) {
  const shell = card.querySelector(".obj-viewer-shell");
  if (!shell) return;
  const body = openMediaModal("OBJ-O");
  body.classList.add("contains-obj");
  const placeholder = document.createComment("obj-viewer-placeholder");
  const originalParent = shell.parentNode;
  originalParent.insertBefore(placeholder, shell);
  body.appendChild(shell);
  mediaModalRestore = () => {
    if (placeholder.parentNode) {
      placeholder.parentNode.insertBefore(shell, placeholder);
      placeholder.remove();
    } else {
      originalParent.appendChild(shell);
    }
  };
  window.setTimeout(() => window.resizeObjOView?.(), 40);
}

function addFullscreenButtons() {
  document.querySelectorAll(".view-card").forEach((card) => {
    const header = card.querySelector(":scope > header");
    if (!header || header.querySelector(".fullscreen-btn")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fullscreen-btn";
    button.title = "放大";
    button.setAttribute("aria-label", "放大");
    button.addEventListener("click", () => {
      if (card.classList.contains("obj-preview-card")) openObjModal(card);
      else openImageModal(card);
    });
    header.appendChild(button);
  });
}

function sampleOptionText(sample, options = {}) {
  const suffixes = [];
  if (sample.review_status_label) suffixes.push(`（${sample.review_status_label}）`);
  if (sample.self_rating === "bad") suffixes.push("（自评差）");
  if (sampleHasInputProblem(sample)) suffixes.push("（有问题）");
  if (options.filterMismatch) suffixes.push("（不符合当前筛选）");
  return `${sample.display_name || sample.name}${suffixes.join("")}`;
}

function checkIssues(check) {
  return Array.isArray(check?.issues) ? check.issues : [];
}

function sampleInputIssues(sample) {
  if (Array.isArray(sample?.input_issues)) return sample.input_issues;
  return checkIssues(sample?.input_check);
}

function problemIssues(issues) {
  return (issues || []).filter((issue) => issue?.level === "error" || issue?.level === "warning");
}

function sampleHasInputProblem(sample) {
  return Boolean(sample?.input_problem) || problemIssues(sampleInputIssues(sample)).length > 0;
}

function issueLine(issue) {
  const message = String(issue?.message || issue?.title || issue?.code || "未知问题").trim();
  const detail = String(issue?.detail || "").trim();
  const path = String(issue?.path || "").trim();
  const parts = [message];
  if (detail && detail !== message) parts.push(detail);
  if (path) parts.push(shortenMiddle(path, 96));
  return parts.filter(Boolean).join("：");
}

function sampleProblemText(sample, limit = 6) {
  return problemIssues(sampleInputIssues(sample))
    .slice(0, limit)
    .map(issueLine)
    .join("；");
}

function sampleProblemIsError(sample) {
  return problemIssues(sampleInputIssues(sample)).some((issue) => issue.level === "error");
}

function datasetProblemText(check, limit = 6) {
  if (!check || check.status === "ok") return "";
  const details = (check.details || []).slice(0, limit).join("；");
  return details ? `${check.label}：${details}` : check.label || "输入文件自检发现问题";
}

function operationCheckText(label, check, limit = 5) {
  const status = check?.summary?.status || "ok";
  const summaryLabel = check?.summary?.label || "通过";
  if (status === "ok") return `${label}通过`;
  const details = problemIssues(checkIssues(check))
    .slice(0, limit)
    .map(issueLine)
    .join("；");
  const statusText = status === "error" ? "失败" : "有警告";
  return details ? `${label}${statusText}：${details}` : `${label}${statusText}：${summaryLabel}`;
}

function setInputCheckStatus() {
  const sample = appState.selectedSample;
  if (sampleHasInputProblem(sample)) {
    const label = sample.display_name || sample.name || "当前样本";
    const summary = sample.input_check?.summary?.label || "输入文件自检发现问题";
    const details = sampleProblemText(sample);
    setStatus(`${label} ${summary}${details ? `：${details}` : ""}`, sampleProblemIsError(sample));
    return true;
  }
  const datasetText = datasetProblemText(appState.inputCheck);
  if (datasetText) {
    setStatus(datasetText, appState.inputCheck?.status === "error");
    return true;
  }
  return false;
}

function statusFilterValue() {
  return $("sampleStatusFilter")?.value || appState.sampleStatusFilter || "all";
}

function ratingFilterValue() {
  return $("sampleRatingFilter")?.value || appState.sampleRatingFilter || "all";
}

function sampleMatchesStatusFilter(sample, filter = statusFilterValue()) {
  const status = sample?.review_status || "";
  if (filter === "all") return true;
  if (filter === "none") return !status;
  return status === filter;
}

function sampleMatchesRatingFilter(sample, filter = ratingFilterValue()) {
  const rating = sample?.self_rating || "";
  if (filter === "all") return true;
  if (filter === "none") return !rating;
  return rating === filter;
}

function sampleMatchesFilters(sample) {
  return sampleMatchesStatusFilter(sample, appState.sampleStatusFilter) && sampleMatchesRatingFilter(sample, appState.sampleRatingFilter);
}

function sampleNeedsAdjustment(sample) {
  const status = sample?.review_status || "";
  return !status || status === "changes_required";
}

function updateAdjustNeededCount() {
  const node = $("adjustNeededCount");
  if (!node) return;
  const total = appState.allSamples.length;
  const needed = appState.allSamples.filter(sampleNeedsAdjustment).length;
  node.textContent = `需修改 ${needed}/${total}`;
  node.title = `待微调 + 已审核待修改：${needed} / 总数：${total}`;
}

function statusLabelForSample(sample) {
  return sample?.review_status_label || sampleStatusLabels[sample?.review_status || ""] || "待微调";
}

function setReviewStatusText(value) {
  const node = $("reviewStatusText");
  if (!node) return;
  const text = value || "待微调";
  if ("value" in node) node.value = text;
  else node.textContent = text;
}

function renderSampleOptions(preferredAnnotationPath = "") {
  const sampleSelect = $("sampleSelect");
  if (!sampleSelect) return null;
  appState.sampleStatusFilter = statusFilterValue();
  appState.sampleRatingFilter = ratingFilterValue();
  const filteredSamples = appState.allSamples.filter((sample) => sampleMatchesFilters(sample));
  const preferredSample = preferredAnnotationPath
    ? appState.allSamples.find((sample) => sample.annotation_path === preferredAnnotationPath)
    : null;
  const keepPreferredVisible = Boolean(
    preferredSample &&
      !filteredSamples.some((sample) => sample.annotation_path === preferredAnnotationPath) &&
      !sampleMatchesFilters(preferredSample),
  );
  appState.samples = keepPreferredVisible ? [preferredSample, ...filteredSamples] : filteredSamples;
  updateAdjustNeededCount();
  sampleSelect.innerHTML = "";
  for (const sample of appState.samples) {
    const filterMismatch = keepPreferredVisible && sample.annotation_path === preferredAnnotationPath;
    const option = document.createElement("option");
    option.value = sample.annotation_path;
    option.textContent = sampleOptionText(sample, { filterMismatch });
    if (sampleHasInputProblem(sample)) {
      option.classList.add("problem");
      option.title = sampleProblemText(sample, 10);
    }
    if (filterMismatch) {
      option.classList.add("filter-mismatch");
      const hint = "当前样本不符合当前筛选条件，临时保留在列表中。";
      option.title = option.title ? `${option.title}；${hint}` : hint;
    }
    sampleSelect.appendChild(option);
  }
  const selected =
    appState.samples.find((sample) => sample.annotation_path === preferredAnnotationPath) ||
    appState.samples[0] ||
    null;
  if (selected) sampleSelect.value = selected.annotation_path;
  return selected;
}

function refreshSampleOption(sample) {
  const sampleSelect = $("sampleSelect");
  if (!sampleSelect || !sample) return;
  for (const option of sampleSelect.options) {
    if (option.value === sample.annotation_path) {
      option.textContent = sampleOptionText(sample);
      option.title = sampleHasInputProblem(sample) ? sampleProblemText(sample, 10) : "";
      return;
    }
  }
}

function placeActionButtons() {
  const actions = document.querySelector(".top-actions");
  const status = $("statusText");
  if (actions && status?.parentNode && actions.parentNode !== status.parentNode) {
    status.parentNode.insertBefore(actions, status);
  }
}

function fileUrl(path) {
  return `/api/file?path=${encodeURIComponent(path)}&t=${Date.now()}`;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return JSON.parse(text);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error);
  return data;
}

function setStatus(message, isError = false) {
  const node = $("statusText");
  const text = String(message || "");
  node.textContent = text;
  node.title = text;
  node.classList.toggle("error", Boolean(isError));
}

async function refreshBackendLog() {
  const box = $("backendLogBox");
  if (!box) return;
  try {
    const data = await getJson(`/api/logs?lines=160&t=${Date.now()}`);
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const text = lines.join("\n");
    appState.logPath = data.path || "";
    box.title = appState.logPath;
    box.textContent = text || "暂无日志";
    if (text !== appState.lastLogText) {
      appState.lastLogText = text;
      box.scrollTop = box.scrollHeight;
    }
  } catch (error) {
    box.textContent = `日志读取失败：${error.message || String(error)}`;
    box.title = "";
  }
}

function startBackendLogPolling() {
  window.clearInterval(appState.logTimer);
  refreshBackendLog();
  appState.logTimer = window.setInterval(refreshBackendLog, 2000);
}

function showToast(message, isError = false, duration = 1800) {
  let node = $("toastNotice");
  if (!node) {
    node = document.createElement("div");
    node.id = "toastNotice";
    node.className = "toast-notice";
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.toggle("error", Boolean(isError));
  node.classList.add("show");
  window.clearTimeout(node.dataset.timerId ? Number(node.dataset.timerId) : 0);
  delete node.dataset.timerId;
  if (duration !== null && Number(duration) > 0) {
    const timerId = window.setTimeout(() => node.classList.remove("show"), Number(duration));
    node.dataset.timerId = String(timerId);
  }
}

function showStageToast(message) {
  showToast(message, false, null);
}

function finishStageToast(message, isError = false) {
  showToast(message, isError, isError ? 3200 : 1400);
}

function numberValue(id) {
  const value = Number($(id).value);
  if (!Number.isFinite(value)) throw new Error(`${id} 不是有效数字`);
  return value;
}

function setNumber(id, value, digits = 6) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    $(id).value = "";
    return;
  }
  let text = Number(value).toFixed(digits);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  $(id).value = text;
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function worldToCamera(point, camera) {
  const delta = [point[0] - camera.position[0], point[1] - camera.position[1], point[2] - camera.position[2]];
  return [dot(delta, camera.x_view), dot(delta, camera.y_view), dot(delta, camera.z_view)];
}

function cameraToWorld(coords, camera) {
  return add(add(add(camera.position, scale(camera.x_view, coords[0])), scale(camera.y_view, coords[1])), scale(camera.z_view, coords[2]));
}

function projectWorldToPixels(point, camera, width, height) {
  const cameraPoint = worldToCamera(point, camera);
  const depth = -cameraPoint[2];
  if (depth <= 1e-9) return null;
  const focal = Number(camera.focal_length_mm);
  const halfSensorWidth = Number(camera.sensor_width_mm) * 0.5;
  const halfSensorHeight = Number(camera.sensor_height_mm) * 0.5;
  const ndcX = (cameraPoint[0] * focal) / (depth * halfSensorWidth);
  const ndcY = (cameraPoint[1] * focal) / (depth * halfSensorHeight);
  return [(ndcX + 1.0) * 0.5 * (width - 1), (1.0 - (ndcY + 1.0) * 0.5) * (height - 1)];
}

function labelBoxCorners(group, camera) {
  const center = group?.label_world_center;
  const size = group?.box_size;
  if (!center || !size || size.length < 3) return [];
  const half = [Number(size[0]) * 0.5, Number(size[1]) * 0.5, Number(size[2]) * 0.5];
  const corners = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push(add(add(add(center, scale(camera.x_view, sx * half[0])), scale(camera.y_view, sy * half[1])), scale(camera.z_view, sz * half[2])));
      }
    }
  }
  return corners;
}

function projectedLabelBounds(group, camera, width, height) {
  const points = labelBoxCorners(group, camera)
    .map((point) => projectWorldToPixels(point, camera, width, height))
    .filter(Boolean);
  if (!points.length) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    left: Math.max(0, Math.min(...xs)),
    top: Math.max(0, Math.min(...ys)),
    right: Math.min(width, Math.max(...xs)),
    bottom: Math.min(height, Math.max(...ys)),
  };
}

function markDirty(positionChanged = true) {
  appState.dirty = true;
  if (positionChanged) {
    appState.tempObjOStale = true;
    setStatus("已记录当前位置；切换标签/锚点不会生成投影，点击“生成投影”后再更新投影和微调中 OBJ-O。");
    renderViewGuides();
    updateObjOSourceSelect(appState.data);
    if (selectedObjOSource() === "temp") {
      refreshObjOPreview(appState.data, true);
    }
  } else {
    setStatus("已记录页面信息。");
  }
}

function currentGroup() {
  return appState.data?.groups?.[appState.selectedIndex] || null;
}

function targetKey(index = appState.selectedIndex, kind = appState.selectedKind) {
  return `${kind}:${index}`;
}

function clonePoint(point) {
  return Array.isArray(point) ? point.map(Number) : null;
}

function samePoint(a, b) {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Math.abs(Number(value) - Number(b[index])) <= 1e-9);
}

function positionSnapshot() {
  if (!appState.data?.loaded) return null;
  return {
    selectedIndex: appState.selectedIndex,
    selectedKind: appState.selectedKind,
    groups: (appState.data.groups || []).map((group) => ({
      index: group.index,
      label_camera_center: clonePoint(group.label_camera_center),
      label_world_center: clonePoint(group.label_world_center),
      anchor_camera_center: clonePoint(group.anchor_camera_center),
      anchor_world: clonePoint(group.anchor_world),
    })),
  };
}

function snapshotsEqual(a, b) {
  if (!a || !b) return true;
  if ((a.groups || []).length !== (b.groups || []).length) return false;
  return (a.groups || []).every((group, index) => {
    const other = b.groups[index];
    return (
      other &&
      Number(group.index) === Number(other.index) &&
      samePoint(group.label_camera_center, other.label_camera_center) &&
      samePoint(group.label_world_center, other.label_world_center) &&
      samePoint(group.anchor_camera_center, other.anchor_camera_center) &&
      samePoint(group.anchor_world, other.anchor_world)
    );
  });
}

function updateHistoryButtons() {
  const undoButton = $("undoBtn");
  const redoButton = $("redoBtn");
  if (undoButton) undoButton.disabled = !appState.undoStack.length;
  if (redoButton) redoButton.disabled = !appState.redoStack.length;
}

function resetPositionHistory() {
  appState.undoStack = [];
  appState.redoStack = [];
  appState.pendingHistorySnapshot = null;
  updateHistoryButtons();
}

function pushPositionHistory(beforeSnapshot) {
  if (appState.historyRestoring || !beforeSnapshot) return;
  const afterSnapshot = positionSnapshot();
  if (!afterSnapshot || snapshotsEqual(beforeSnapshot, afterSnapshot)) return;
  appState.undoStack.push(beforeSnapshot);
  if (appState.undoStack.length > appState.historyLimit) appState.undoStack.shift();
  appState.redoStack = [];
  updateHistoryButtons();
}

function beginPositionHistory() {
  if (appState.historyRestoring || appState.pendingHistorySnapshot || !appState.data?.loaded) return;
  appState.pendingHistorySnapshot = positionSnapshot();
}

function commitPositionHistory() {
  const beforeSnapshot = appState.pendingHistorySnapshot;
  appState.pendingHistorySnapshot = null;
  pushPositionHistory(beforeSnapshot);
}

function restorePositionSnapshot(snapshot, message) {
  if (!snapshot || !appState.data?.loaded) return;
  appState.historyRestoring = true;
  try {
    for (const savedGroup of snapshot.groups || []) {
      const group = (appState.data.groups || [])[Number(savedGroup.index)];
      if (!group) continue;
      group.label_camera_center = clonePoint(savedGroup.label_camera_center);
      group.label_world_center = clonePoint(savedGroup.label_world_center);
      group.anchor_camera_center = clonePoint(savedGroup.anchor_camera_center);
      group.anchor_world = clonePoint(savedGroup.anchor_world);
    }
    appState.selectedIndex = Math.min(Math.max(Number(snapshot.selectedIndex || 0), 0), Math.max(0, (appState.data.groups || []).length - 1));
    appState.selectedKind = snapshot.selectedKind === "anchor" ? "anchor" : "label";
    const targetKindInput = document.querySelector(`input[name="targetKind"][value="${appState.selectedKind}"]`);
    if (targetKindInput) targetKindInput.checked = true;
    window.clearTimeout(appState.anchorSnapTimer);
    appState.anchorSnapPending = false;
    appState.dirty = true;
    appState.tempObjOStale = true;
    renderTargetSelector();
    renderSelectedTarget();
    updateObjOSourceSelect(appState.data);
    if (selectedObjOSource() === "temp") refreshObjOPreview(appState.data, true);
    setStatus(message);
  } finally {
    appState.historyRestoring = false;
  }
}

function undoPosition() {
  commitPositionHistory();
  if (!appState.undoStack.length) return;
  const currentSnapshot = positionSnapshot();
  const previousSnapshot = appState.undoStack.pop();
  if (currentSnapshot) appState.redoStack.push(currentSnapshot);
  restorePositionSnapshot(previousSnapshot, "已回到上一步移动。");
  updateHistoryButtons();
}

function redoPosition() {
  commitPositionHistory();
  if (!appState.redoStack.length) return;
  const currentSnapshot = positionSnapshot();
  const nextSnapshot = appState.redoStack.pop();
  if (currentSnapshot) appState.undoStack.push(currentSnapshot);
  restorePositionSnapshot(nextSnapshot, "已恢复下一步移动。");
  updateHistoryButtons();
}

function captureTargetBaselines(data, force = false) {
  if (!data?.loaded) return;
  if (!force && appState.baselineAnnotationPath === data.annotation_path && appState.targetBaselines.size) return;
  appState.baselineAnnotationPath = data.annotation_path || "";
  appState.targetBaselines = new Map();
  (data.groups || []).forEach((group, index) => {
    appState.targetBaselines.set(targetKey(index, "label"), clonePoint(group.label_world_center));
    appState.targetBaselines.set(targetKey(index, "anchor"), clonePoint(group.anchor_world));
  });
}

function baselineWorldFor(index = appState.selectedIndex, kind = appState.selectedKind) {
  return appState.targetBaselines.get(targetKey(index, kind)) || null;
}

function distance3(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(Number(a[0]) - Number(b[0]), Number(a[1]) - Number(b[1]), Number(a[2]) - Number(b[2]));
}

function hasMeaningfulMove(a, b) {
  return distance3(a, b) > moveTraceMinDistance;
}

function currentTargetCamera(group = currentGroup()) {
  if (!group) return null;
  return appState.selectedKind === "anchor" ? group.anchor_camera_center : group.label_camera_center;
}

function currentTargetWorld(group = currentGroup()) {
  if (!group) return null;
  return appState.selectedKind === "anchor" ? group.anchor_world : group.label_world_center;
}

function displayTargetId(index = appState.selectedIndex, kind = appState.selectedKind) {
  return `${kind === "anchor" ? "anchor" : "label"}_${index + 1}`;
}

function setCurrentTargetCamera(group, cameraCenter) {
  const mainCamera = appState.data?.view_cameras?.main;
  if (!group || !mainCamera) return;
  const worldCenter = cameraToWorld(cameraCenter.map(Number), mainCamera);
  if (appState.selectedKind === "anchor") {
    group.anchor_camera_center = cameraCenter;
    group.anchor_world = worldCenter;
  } else {
    group.label_camera_center = cameraCenter;
    group.label_world_center = worldCenter;
  }
}

function syncSelectedFromInputs() {
  const group = currentGroup();
  if (!group) return;
  const coords = [numberValue("camX"), numberValue("camY"), numberValue("camZ")];
  setCurrentTargetCamera(group, coords);
  const world = currentTargetWorld(group);
  setNumber("worldX", world?.[0], 6);
  setNumber("worldY", world?.[1], 6);
  setNumber("worldZ", world?.[2], 6);
}

function refreshStateAfterAnchorSnap(data) {
  if (!data?.loaded || !appState.data) return;
  appState.data.groups = data.groups || appState.data.groups;
  appState.data.camera = data.camera || appState.data.camera;
  appState.data.view_cameras = data.view_cameras || appState.data.view_cameras;
  appState.data.text_objs_available = data.text_objs_available;
  appState.data.text_objs_dir = data.text_objs_dir;
  appState.data.missing_text_objs = data.missing_text_objs || [];
  renderTargetSelector();
  renderSelectedTarget();
  updateSaveButtons(appState.data);
}

function describeSnapReport(report) {
  if (!report?.snapped) return "";
  const distance = Number(report.distance || 0).toFixed(4);
  return `${displayTargetId(report.index, "anchor")} 已偏离目标部件，已吸附到最近表面，距离 ${distance}`;
}

function scheduleAnchorSnap(delay = 120) {
  if (!appState.data?.loaded || appState.selectedKind !== "anchor") return;
  window.clearTimeout(appState.anchorSnapTimer);
  appState.anchorSnapTimer = window.setTimeout(runAnchorSnap, delay);
}

async function runAnchorSnap() {
  if (!appState.data?.loaded || appState.selectedKind !== "anchor") return;
  if (appState.anchorSnapBusy) {
    appState.anchorSnapPending = true;
    return;
  }
  appState.anchorSnapBusy = true;
  appState.anchorSnapPending = false;
  const index = appState.selectedIndex;
  try {
    const payload = payloadFromState();
    payload.index = index;
    const data = await postJson("/api/snap_anchor", payload);
    if (appState.selectedKind === "anchor" && appState.selectedIndex === index) {
      refreshStateAfterAnchorSnap(data);
    } else if (data?.loaded && appState.data) {
      appState.data.groups = data.groups || appState.data.groups;
    }
    const message = describeSnapReport(data.anchor_snap_report);
    if (message) showToast(message);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    appState.anchorSnapBusy = false;
    if (appState.anchorSnapPending) scheduleAnchorSnap(80);
  }
}

function resetMoveSliders() {
  sliderIds.forEach((id, axis) => {
    const slider = $(id);
    if (!slider) return;
    slider.value = "0";
    slider.dataset.base = String(Number($(axisInputs[axis]).value || 0));
  });
}

function primeMoveSlider(slider) {
  const axis = Number(slider.dataset.axis);
  slider.dataset.base = String(Number($(axisInputs[axis]).value || 0));
}

function applyMoveSlider(slider) {
  beginPositionHistory();
  const axis = Number(slider.dataset.axis);
  if (!slider.dataset.base) primeMoveSlider(slider);
  const base = Number(slider.dataset.base || 0);
  const step = numberValue("stepSize");
  const next = base + Number(slider.value || 0) * step;
  $(axisInputs[axis]).value = next.toFixed(6);
  syncSelectedFromInputs();
  markDirty();
  scheduleAnchorSnap();
}

function finishMoveSlider(slider) {
  const axis = Number(slider.dataset.axis);
  slider.dataset.base = String(Number($(axisInputs[axis]).value || 0));
  slider.value = "0";
  commitPositionHistory();
}

function editorNameValue() {
  return $("editorName")?.value.trim() || "";
}

function selfRatingValue() {
  return $("selfRating")?.value || "";
}

function adjusterRemarkValue() {
  return $("adjusterRemark")?.value.trim() || "";
}

function selectedObjOView() {
  return $("objOViewSelect")?.value || appState.objOView || "main";
}

function selectedObjOSource() {
  return $("objOSourceSelect")?.value || appState.objOSource || "input";
}

function objOInfoForSource(data, source = selectedObjOSource()) {
  return data?.obj_o_sources?.[source] || null;
}

function updateObjOUpdateHint() {
  const hint = $("objOUpdateHint");
  if (!hint) return;
  hint.classList.toggle("hidden", !(selectedObjOSource() === "temp" && appState.tempObjOStale));
}

function updateObjOSourceSelect(data) {
  const select = $("objOSourceSelect");
  if (!select) return;
  const previous = selectedObjOSource();
  for (const option of select.options) {
    const info = objOInfoForSource(data, option.value);
    const suffix = data?.loaded && !info?.exists ? "（无）" : "";
    option.textContent = `${objOSourceLabels[option.value] || option.value}${suffix}`;
  }
  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  } else {
    select.value = data?.obj_o_default_source || "input";
  }
  appState.objOSource = select.value;
  updateObjOUpdateHint();
}

function updateObjOViewSelect(data) {
  const select = $("objOViewSelect");
  if (!select) return;
  const previous = selectedObjOView();
  const info = objOInfoForSource(data);
  const available = info?.exists_by_view || {};
  for (const option of select.options) {
    option.textContent = viewLabels[option.value] || option.value;
    option.disabled = Boolean(data?.loaded) && available[option.value] === false && !info?.paths?.[option.value];
  }
  select.disabled = Boolean(data?.loaded) && !info?.exists;
  const next = available[previous] === false && !info?.paths?.[previous] ? "main" : previous;
  select.value = next;
  appState.objOView = next;
}

function renderExistingOutputNotice(data) {
  const title = $("sampleTitle");
  const hasManualOutput = Boolean(data?.manual_output_complete);
  title?.classList.toggle("manual-output-ready", hasManualOutput);
  if (title) {
    title.title = hasManualOutput ? "输出目录中已有人工微调后的完整结果" : "";
  }
}

function requireEditorName(actionLabel = "保存") {
  if (editorNameValue()) return true;
  $("editorName")?.focus();
  updateSaveButtons(appState.data);
  setStatus(`请先输入名字，再${actionLabel}。`, true);
  return false;
}

function requireSelfRating(actionLabel = "保存") {
  if (selfRatingValue()) return true;
  $("selfRating")?.focus();
  updateSaveButtons(appState.data);
  setStatus(`请先选择自评（好/中/差），再${actionLabel}。`, true);
  return false;
}

function outputPayload() {
  return { output_root: pathInputValue("outputRoot") };
}

function metadataPayload() {
  return {
    self_rating: selfRatingValue(),
    adjuster_remark: adjusterRemarkValue(),
  };
}

function payloadFromState(options = {}) {
  syncSelectedFromInputs();
  if (options.commitHistory) commitPositionHistory();
  return {
    annotation_path: appState.data?.annotation_path || "",
    editor_name: editorNameValue(),
    output: outputPayload(),
    metadata: metadataPayload(),
    groups: (appState.data?.groups || []).map((group) => ({
      index: group.index,
      label_camera_center: group.label_camera_center.map(Number),
      anchor_camera_center: group.anchor_camera_center.map(Number),
    })),
  };
}

async function refreshSamples(options = {}) {
  showStageToast("正在刷新文件列表...");
  try {
    const root = pathInputValue("datasetRoot");
    const outputRoot = pathInputValue("outputRoot");
    const data = await getJson(`/api/samples?root=${encodeURIComponent(root)}&output_root=${encodeURIComponent(outputRoot)}`);
    appState.allSamples = data.samples || [];
    appState.inputCheck = data.input_check || null;
    const selected = renderSampleOptions();
    if (appState.samples.length) {
      const firstOpen = appState.samples.find((sample) => sample.review_status !== "reviewed") || selected;
      selectSample(firstOpen.annotation_path);
      finishStageToast("文件列表刷新完成");
      if (options.autoLoad) {
        await loadAnnotation();
      }
    } else {
      appState.selectedSample = null;
      $("sampleTitle").textContent = "未找到样本";
      const hasAnySamples = appState.allSamples.length > 0;
      const checkText = datasetProblemText(appState.inputCheck);
      setStatus(checkText || (hasAnySamples ? "当前筛选条件下没有样本。" : "输入根目录下没有找到 Annotation JSON。"), true);
      finishStageToast(hasAnySamples ? "当前筛选无样本" : "没有找到可加载的样本", true);
    }
  } catch (error) {
    finishStageToast(error.message || String(error), true);
    setStatus(error.message || String(error), true);
  }
}

async function refreshSamplesPreservingCurrent(preferredAnnotationPath) {
  const root = pathInputValue("datasetRoot");
  const outputRoot = pathInputValue("outputRoot");
  const data = await getJson(`/api/samples?root=${encodeURIComponent(root)}&output_root=${encodeURIComponent(outputRoot)}`);
  appState.allSamples = data.samples || [];
  appState.inputCheck = data.input_check || null;
  renderSampleOptions(preferredAnnotationPath);
  const matched = appState.allSamples.find((item) => item.annotation_path === preferredAnnotationPath);
  if (matched) {
    appState.selectedSample = matched;
    if (sampleMatchesStatusFilter(matched) && sampleMatchesRatingFilter(matched) && $("sampleSelect")) $("sampleSelect").value = matched.annotation_path;
    setPathInputValue("annotationPath", matched.annotation_path || "");
    setPathInputValue("objPath", matched.obj_p_path || "");
    updateLoadButtons();
  }
}

function selectSample(annotationPath) {
  appState.selectedSample = appState.allSamples.find((item) => item.annotation_path === annotationPath) || null;
  if (!appState.selectedSample) return;
  $("sampleSelect").value = annotationPath;
  setPathInputValue("annotationPath", appState.selectedSample.annotation_path || "");
  setPathInputValue("objPath", appState.selectedSample.obj_p_path || "");
  if ($("adminRatingText")) $("adminRatingText").value = appState.selectedSample.admin_rating_label || reviewRatingLabels[appState.selectedSample.admin_rating] || "";
  setReviewStatusText(statusLabelForSample(appState.selectedSample));
  if ($("adminRemarkText")) $("adminRemarkText").value = "";
  const currentOutput = pathInputValue("outputRoot");
  if (!currentOutput) {
    setPathInputValue("outputRoot", appState.data?.output_root || "");
  }
  $("sampleTitle").textContent = appState.selectedSample.display_name || appState.selectedSample.name;
  updateLoadButtons();
  if (!setInputCheckStatus()) {
    setStatus("已选择样本；如已有 output 微调结果会优先加载，必要时可点击“从 input 加载”。");
  }
}

function renderCamera(camera) {
  if (!camera) return;
  setNumber("cameraRadius", camera.camera_radius, 4);
  setNumber("focalLength", camera.focal_length_mm, 4);
  setNumber("sensorWidth", camera.sensor_width_mm, 4);
  setNumber("sensorHeight", camera.sensor_height_mm, 4);
  setNumber("nearClip", camera.near_clip, 8);
  setNumber("farClip", camera.far_clip, 2);
  setNumber("perturbDegrees", camera.perturb_degrees ?? 45, 4);
  setNumber("imageWidth", camera.projection_image_width, 0);
  setNumber("imageHeight", camera.projection_image_height, 0);
}

function renderTargetSelector() {
  const groups = appState.data?.groups || [];
  const select = $("targetSelect");
  select.innerHTML = "";
  groups.forEach((group, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${displayTargetId(index, appState.selectedKind)} | ${group.group_id}`;
    select.appendChild(option);
  });
  if (groups.length && appState.selectedIndex >= groups.length) appState.selectedIndex = groups.length - 1;
  select.value = String(appState.selectedIndex);
}

function renderSelectedTarget() {
  const group = currentGroup();
  if (!group) {
    $("targetTitle").textContent = "-";
    $("targetText").textContent = "-";
    return;
  }
  $("targetTitle").textContent = `${displayTargetId(appState.selectedIndex, appState.selectedKind)} | ${group.group_id}`;
  $("targetText").textContent = group.text || group.group_id;
  const camera = currentTargetCamera(group);
  const world = currentTargetWorld(group);
  setNumber("camX", camera?.[0], 6);
  setNumber("camY", camera?.[1], 6);
  setNumber("camZ", camera?.[2], 6);
  setNumber("worldX", world?.[0], 6);
  setNumber("worldY", world?.[1], 6);
  setNumber("worldZ", world?.[2], 6);
  setNumber("boxX", group.box_size?.[0], 6);
  setNumber("boxY", group.box_size?.[1], 6);
  setNumber("boxZ", group.box_size?.[2], 6);
  resetMoveSliders();
  renderViewGuides();
}

function renderImages(images, partImages) {
  for (const [view, id] of Object.entries(viewIds)) {
    const img = $(id);
    if (images?.[view]) img.src = fileUrl(images[view]);
    else img.removeAttribute("src");
  }
  for (const [view, id] of Object.entries(partIds)) {
    const img = $(id);
    if (partImages?.[view]) img.src = fileUrl(partImages[view]);
    else img.removeAttribute("src");
  }
}

function bestMove(candidates, direction) {
  const score = {
    right: (item) => item.dx,
    left: (item) => -item.dx,
    up: (item) => -item.dy,
    down: (item) => item.dy,
  }[direction];
  return candidates.reduce((best, item) => (score(item) > score(best) ? item : best), candidates[0]);
}

function movementCandidates(viewCamera, baseWorld, step, width, height) {
  const mainCamera = appState.data?.view_cameras?.main;
  if (!mainCamera) return [];
  const basePixel = projectWorldToPixels(baseWorld, viewCamera, width, height);
  if (!basePixel) return [];

  const result = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const axisVector = [mainCamera.x_view, mainCamera.y_view, mainCamera.z_view][axis];
    for (const sign of [1, -1]) {
      const movedWorld = add(baseWorld, scale(axisVector, step * sign));
      const movedPixel = projectWorldToPixels(movedWorld, viewCamera, width, height);
      if (!movedPixel) continue;
      const dx = movedPixel[0] - basePixel[0];
      const dy = movedPixel[1] - basePixel[1];
      result.push({ label: `${sign > 0 ? "+" : "-"}${axisNames[axis]}`, dx, dy, length: Math.hypot(dx, dy), basePixel });
    }
  }
  return result;
}

function renderSideCompass(node, candidates, positiveAxes) {
  const visibleCandidates = candidates.filter((item) => item.length >= minVisibleMove);
  const visiblePositiveAxes = positiveAxes.filter((item) => item.length >= minVisibleMove);
  if (!visibleCandidates.length || !visiblePositiveAxes.length) {
    node.innerHTML = "";
    return;
  }

  const centerX = 54;
  const centerY = 54;
  const compass = visiblePositiveAxes
    .map((item, index) => {
      const color = axisColors[item.label] || "#222";
      const length = Math.max(item.length, 0.001);
      const displayLength = 38 + index * 3;
      const unitX = item.dx / length;
      const unitY = item.dy / length;
      const x2 = centerX + unitX * displayLength;
      const y2 = centerY + unitY * displayLength;
      const textX = Math.min(Math.max(x2 + unitX * 8 - 12, 2), 89);
      const textY = Math.min(Math.max(y2 + unitY * 8 + 5, 14), 104);
      return `<line x1="${centerX}" y1="${centerY}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3" stroke-linecap="round" />
              <circle cx="${x2}" cy="${y2}" r="3.4" fill="${color}" />
              <text x="${textX}" y="${textY}" fill="${color}" font-size="14" font-weight="900">${item.label}</text>`;
    })
    .join("");

  node.innerHTML = `
    <svg class="legend-compass" viewBox="0 0 108 108">
      <circle cx="${centerX}" cy="${centerY}" r="3" fill="#111" />
      ${compass}
    </svg>
  `;
}

function markerMarkup(x, y, color, label, style = "solid") {
  const dash = style === "dashed" ? ' stroke-dasharray="5 4"' : "";
  const opacity = style === "dashed" ? ' opacity="0.82"' : "";
  return `
    <g${opacity}>
      <circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${color}" stroke-width="3"${dash} />
      <line x1="${x - 11}" y1="${y}" x2="${x + 11}" y2="${y}" stroke="${color}" stroke-width="2" />
      <line x1="${x}" y1="${y - 11}" x2="${x}" y2="${y + 11}" stroke="${color}" stroke-width="2" />
      <text x="${x + 12}" y="${Math.max(18, y - 10)}" fill="${color}" font-size="15" font-weight="900">${label}</text>
    </g>
  `;
}

function movedTargetEntries() {
  const entries = [];
  const groups = appState.data?.groups || [];
  groups.forEach((group, index) => {
    for (const kind of ["label", "anchor"]) {
      const startWorld = baselineWorldFor(index, kind);
      const endWorld = kind === "anchor" ? group.anchor_world : group.label_world_center;
      if (startWorld && endWorld && hasMeaningfulMove(startWorld, endWorld)) {
        entries.push({ index, kind, group, startWorld, endWorld });
      }
    }
  });
  return entries;
}

function movedTargetOverlayMarkup(entry, viewCamera, width, height, options = {}) {
  const startPoint = projectWorldToPixels(entry.startWorld, viewCamera, width, height);
  const endPoint = projectWorldToPixels(entry.endWorld, viewCamera, width, height);
  if (!startPoint || !endPoint) return "";
  const moveColor = "#15803d";
  const sx = Math.max(0, Math.min(width, startPoint[0]));
  const sy = Math.max(0, Math.min(height, startPoint[1]));
  const ex = Math.max(0, Math.min(width, endPoint[0]));
  const ey = Math.max(0, Math.min(height, endPoint[1]));
  const targetLabel = displayTargetId(entry.index, entry.kind);
  const startLabel = `${targetLabel} 起点`;
  const endLabel = `${targetLabel} 终点`;
  let boxMarkup = "";
  if (entry.kind === "label") {
    const bounds = projectedLabelBounds(entry.group, viewCamera, width, height);
    if (bounds) {
      const boxWidth = Math.max(1, bounds.right - bounds.left);
      const boxHeight = Math.max(1, bounds.bottom - bounds.top);
      boxMarkup = `<rect x="${bounds.left}" y="${bounds.top}" width="${boxWidth}" height="${boxHeight}" fill="rgba(21, 128, 61, 0.08)" stroke="${moveColor}" stroke-width="${options.current ? 3 : 2}" stroke-dasharray="10 6" />`;
    }
  }
  return `
    ${boxMarkup}
    ${markerMarkup(sx, sy, moveColor, startLabel, "dashed")}
    ${markerMarkup(ex, ey, moveColor, endLabel, "solid")}
  `;
}

function renderSelectionMarker(svg, viewCamera, targetWorld, width, height, group) {
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const point = projectWorldToPixels(targetWorld, viewCamera, width, height);
  if (!point) {
    svg.innerHTML = movedTargetEntries()
      .map((entry) => movedTargetOverlayMarkup(entry, viewCamera, width, height))
      .join("");
    return;
  }
  const color = appState.selectedKind === "anchor" ? "#ff2f2f" : "#1f57ff";
  const label = displayTargetId(appState.selectedIndex, appState.selectedKind);
  const x = Math.max(0, Math.min(width, point[0]));
  const y = Math.max(0, Math.min(height, point[1]));
  const textX = Math.min(x + 12, width - 110);
  const textY = Math.max(18, y - 10);
  const startWorld = baselineWorldFor(appState.selectedIndex, appState.selectedKind);
  const startPoint = startWorld ? projectWorldToPixels(startWorld, viewCamera, width, height) : null;
  const hasMoved = Boolean(startPoint && hasMeaningfulMove(startWorld, targetWorld));
  const currentKey = targetKey(appState.selectedIndex, appState.selectedKind);
  const movedMarkup = movedTargetEntries()
    .filter((entry) => targetKey(entry.index, entry.kind) !== currentKey)
    .map((entry) => movedTargetOverlayMarkup(entry, viewCamera, width, height))
    .join("");
  let boxMarkup = "";
  if (appState.selectedKind === "label") {
    const bounds = projectedLabelBounds(group, viewCamera, width, height);
    if (bounds) {
      const boxWidth = Math.max(1, bounds.right - bounds.left);
      const boxHeight = Math.max(1, bounds.bottom - bounds.top);
      const boxColor = hasMoved ? "#15803d" : color;
      const boxFill = hasMoved ? "rgba(21, 128, 61, 0.08)" : "rgba(31, 87, 255, 0.08)";
      boxMarkup = `
        <rect x="${bounds.left}" y="${bounds.top}" width="${boxWidth}" height="${boxHeight}" fill="${boxFill}" stroke="${boxColor}" stroke-width="3" stroke-dasharray="10 6" />
      `;
    }
  }
  if (hasMoved) {
    const currentMovedMarkup = movedTargetOverlayMarkup(
      {
        index: appState.selectedIndex,
        kind: appState.selectedKind,
        group,
        startWorld,
        endWorld: targetWorld,
      },
      viewCamera,
      width,
      height,
      { current: true },
    );
    svg.innerHTML = `
      ${movedMarkup}
      ${currentMovedMarkup}
    `;
    return;
  }
  svg.innerHTML = `
    ${movedMarkup}
    ${boxMarkup}
    <circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${color}" stroke-width="3" />
    <line x1="${x - 11}" y1="${y}" x2="${x + 11}" y2="${y}" stroke="${color}" stroke-width="2" />
    <line x1="${x}" y1="${y - 11}" x2="${x}" y2="${y + 11}" stroke="${color}" stroke-width="2" />
    <text x="${textX}" y="${textY}" fill="${color}" font-size="16" font-weight="900">${label}</text>
  `;
}

function renderViewGuides() {
  const group = currentGroup();
  const cameras = appState.data?.view_cameras;
  if (!group || !cameras) return;
  const step = Number($("stepSize").value || 0);
  const width = Number($("imageWidth").value || 750);
  const height = Number($("imageHeight").value || 500);
  const baseWorld = currentTargetWorld(group);

  for (const view of Object.keys(guideIds)) {
    const node = $(guideIds[view]);
    const svg = $(overlayIds[view]);
    if (svg) svg.dataset.view = view;
    const camera = cameras[view];
    if (!node || !svg || !camera || !baseWorld || !Number.isFinite(step) || step <= 0) {
      if (node) node.textContent = "暂无移动提示";
      if (svg) svg.innerHTML = "";
      continue;
    }
    const candidates = movementCandidates(camera, baseWorld, step, width, height);
    if (!candidates.length) {
      node.textContent = "当前对象在该视角后方，无法估算。";
      svg.innerHTML = "";
      continue;
    }
    renderSideCompass(node, candidates, candidates.filter((item) => item.label.startsWith("+")));
    renderSelectionMarker(svg, camera, baseWorld, width, height, group);
  }
}

function renderState(data, options = {}) {
  appState.data = data;
  if (options.resetHistory) resetPositionHistory();
  if (!data.loaded) {
    if ($("adminRatingText")) $("adminRatingText").value = "";
    setReviewStatusText("待微调");
    if ($("adminRemarkText")) $("adminRemarkText").value = "";
    refreshObjOPreview(data, Boolean(options.forceObjPreview));
    renderExistingOutputNotice(data);
    updateLoadButtons();
    updateSaveButtons(data);
    if (!setInputCheckStatus()) {
      setStatus("还没有加载 JSON。", true);
    }
    return;
  }
  captureTargetBaselines(data);

  setPathInputValue("datasetRoot", data.dataset_root || pathInputValue("datasetRoot"));
  if (data.annotation_path && $("sampleSelect")) {
    const matched = appState.allSamples.find((item) => item.annotation_path === data.annotation_path);
    if (matched) {
      matched.manual_output_complete = Boolean(data.manual_output_complete);
      matched.manual_output_layout_dir = data.manual_output_info?.layout_dir || matched.manual_output_layout_dir;
      matched.review_status = data.review_status || "";
      matched.review_status_label = data.review_status_label || "";
      matched.reviewed = Boolean(data.reviewed);
      matched.self_rating = data.self_rating || "";
      matched.admin_rating = data.admin_rating || "";
      matched.admin_rating_label = data.admin_rating_label || "";
      appState.selectedSample = matched;
      renderSampleOptions(data.annotation_path);
      if (sampleMatchesStatusFilter(matched) && sampleMatchesRatingFilter(matched)) $("sampleSelect").value = data.annotation_path;
    }
  }
  const stateOutput = data.output_root || pathInputValue("outputRoot") || data.dataset_root || "";
  setPathInputValue("outputRoot", stateOutput);
  if (data.editor_name && $("editorName")) $("editorName").value = data.editor_name;
  if ($("selfRating")) $("selfRating").value = data.self_rating || "";
  if ($("adjusterRemark")) $("adjusterRemark").value = data.adjuster_remark || "";
  if ($("adminRatingText")) $("adminRatingText").value = data.admin_rating_label || reviewRatingLabels[data.admin_rating] || "";
  setReviewStatusText(data.review_status_label || sampleStatusLabels[data.review_status || ""] || "待微调");
  if ($("adminRemarkText")) $("adminRemarkText").value = data.admin_remark || "";
  setPathInputValue("annotationPath", data.annotation_path || "");
  setPathInputValue("objPath", data.obj_p_path || "");
  $("sampleTitle").textContent = data.annotation_path?.split(/[\\/]/).slice(-3).join(" / ") || "已加载";
  renderCamera(data.camera);
  renderTargetSelector();
  renderSelectedTarget();
  renderImages(data.projection_images, data.part_overlay_images);
  updateObjOSourceSelect(data);
  updateObjOViewSelect(data);
  renderExistingOutputNotice(data);
  updateSaveButtons(data);
  refreshObjOPreview(data, Boolean(options.forceObjPreview));
  appState.dirty = false;
  if (!setInputCheckStatus()) {
    const loadSourceText = data.loaded_from_output ? "已从 output 初始化加载" : "已从 input 加载";
    setStatus(`${loadSourceText}。移动会先记录在页面内存中；需要检查时点击“生成投影”，点击“保存完整结果”会写入 Annotation、Mutiviews 和 Obj-O。`);
  }
}

function selectTarget(index) {
  syncSelectedFromInputs();
  commitPositionHistory();
  appState.selectedIndex = Number(index);
  renderTargetSelector();
  renderSelectedTarget();
  setStatus("已切换对象；移动会记录在页面中，点击“生成投影”后再更新投影。");
}

function refreshObjOPreview(data, force = false) {
  const source = selectedObjOSource();
  const view = selectedObjOView();
  appState.objOSource = source;
  appState.objOView = view;
  if (!window.loadObjOPreview) {
    window.setTimeout(() => {
      if (window.loadObjOPreview) window.loadObjOPreview(data || appState.data, { force, source, view, tempStale: appState.tempObjOStale });
    }, 250);
    return;
  }
  window.loadObjOPreview(data || appState.data, { force, source, view, tempStale: appState.tempObjOStale });
}

window.addEventListener("obj-o-viewer-ready", () => refreshObjOPreview(appState.data));

function updateLoadButtons() {
  const adjustedButton = $("loadAdjustedBtn");
  if (!adjustedButton) return;
  const hasAdjustedOutput = Boolean(appState.selectedSample?.manual_output_complete || appState.data?.manual_output_complete);
  adjustedButton.disabled = !hasAdjustedOutput;
  adjustedButton.title = hasAdjustedOutput ? "从 output/layout1 的结果继续微调" : "当前样本还没有完整的 output 微调结果";
}

function updateSaveButtons(data) {
  const nameInput = $("editorName");
  const ratingSelect = $("selfRating");
  const saveButton = $("saveBtn");
  const exportButton = $("exportZipBtn");
  const hasName = Boolean(editorNameValue());
  const hasRating = Boolean(selfRatingValue());
  const available = Boolean(data?.text_objs_available);
  if (nameInput) {
    nameInput.classList.toggle("required-missing", !hasName);
    nameInput.setAttribute("aria-invalid", hasName ? "false" : "true");
  }
  if (ratingSelect) {
    ratingSelect.classList.toggle("required-missing", !hasRating);
    ratingSelect.setAttribute("aria-invalid", hasRating ? "false" : "true");
  }
  if (saveButton) {
    saveButton.disabled = !hasName || !hasRating || !available;
    if (!hasName) {
      saveButton.title = "请先输入名字";
    } else if (!hasRating) {
      saveButton.title = "请先选择自评（好/中/差）";
    } else if (!available) {
      const missing = (data?.missing_text_objs || []).slice(0, 4).join(", ");
      saveButton.title = missing ? `缺少文字 OBJ: ${missing}` : "未找到 Text_objs";
    } else {
      saveButton.title = "保存 Annotation、Mutiviews 和 Obj-O";
    }
  }
  if (exportButton) {
    exportButton.disabled = !hasName;
    exportButton.title = hasName ? "导出 data/output 为本地 ZIP" : "请先输入名字";
  }
  updateLoadButtons();
  updateHistoryButtons();
}

function updateObjOButton(data) {
  updateSaveButtons(data);
}

function selectTargetKind(kind) {
  syncSelectedFromInputs();
  commitPositionHistory();
  appState.selectedKind = kind;
  renderTargetSelector();
  renderSelectedTarget();
  setStatus("已切换标签/锚点；移动会记录在页面中，点击“生成投影”后再更新投影。");
}

async function loadAnnotation(options = {}) {
  try {
    if (!appState.selectedSample) {
      setStatus("请先选择样本。", true);
      return;
    }
    showStageToast("正在加载样本...");
    window.clearObjOPreview?.();
    const startFromOutput = options.startFromOutput ?? Boolean(appState.selectedSample?.manual_output_complete);
    if (startFromOutput && !appState.selectedSample.manual_output_complete) {
      setStatus("当前样本还没有完整的 output 微调结果。", true);
      finishStageToast("当前样本还没有完整的 output 微调结果", true);
      return;
    }
    setStatus("正在加载 JSON...");
    const data = await postJson("/api/load", {
      annotation_json: appState.selectedSample.annotation_path,
      obj_p_path: appState.selectedSample.obj_p_path || null,
      dataset_root: pathInputValue("datasetRoot"),
      output_root: pathInputValue("outputRoot"),
      start_from_output: startFromOutput,
    });
    appState.selectedIndex = 0;
    appState.selectedKind = "label";
    appState.objOSource = startFromOutput ? "output" : "input";
    appState.objOView = "main";
    appState.tempObjOStale = true;
    appState.baselineAnnotationPath = "";
    appState.targetBaselines = new Map();
    if ($("objOSourceSelect")) $("objOSourceSelect").value = appState.objOSource;
    if ($("objOViewSelect")) $("objOViewSelect").value = "main";
    document.querySelector('input[name="targetKind"][value="label"]').checked = true;
    renderState(data, { resetHistory: true, forceObjPreview: startFromOutput });
    finishStageToast(startFromOutput ? "已从 output 加载" : "已从 input 加载");
  } catch (error) {
    finishStageToast(error.message || String(error), true);
    setStatus(error.message || String(error), true);
  }
}

async function renderProjection(endpoint = "/api/render") {
  if (!appState.data?.loaded) return;
  try {
    const isSave = endpoint === "/api/save";
    if (isSave && !requireEditorName("保存完整结果")) return;
    if (isSave && !requireSelfRating("保存完整结果")) return;
    window.clearTimeout(appState.selectionRenderTimer);
    showStageToast(isSave ? "正在保存完整结果..." : "正在生成投影...");
    setStatus(isSave ? "正在保存 Annotation、Mutiviews 和 Obj-O..." : "正在生成五个预览投影，请稍等...");
    const data = await postJson(endpoint, payloadFromState({ commitHistory: true }));
    if (!isSave) appState.tempObjOStale = false;
    appState.objOSource = isSave ? "output" : "temp";
    if ($("objOSourceSelect")) $("objOSourceSelect").value = appState.objOSource;
    captureTargetBaselines(data, true);
    renderState(data, { forceObjPreview: true });
    if (isSave) await refreshSamplesPreservingCurrent(data.annotation_path);
    finishStageToast(isSave ? "完整结果保存完成" : "投影生成完成");
    const savedPath = data.manual_output_info?.layout_dir || data.adjusted_json_path || "";
    if (isSave) {
      const checkText = operationCheckText("保存结果自检", data.save_check);
      setStatus(`已保存完整结果：${shortenMiddle(savedPath, 72)}；${checkText}`, data.save_check?.summary?.status === "error");
    } else {
      setStatus("预览投影已生成，JSON 未写入。");
    }
  } catch (error) {
    finishStageToast(error.message || String(error), true);
    setStatus(error.message || String(error), true);
  }
}

async function downloadExportZip() {
  try {
    if (!requireEditorName("导出 ZIP")) return;
    const outputRoot = pathInputValue("outputRoot");
    if (!outputRoot) {
      setStatus("请先填写输出根目录。", true);
      return;
    }
    showStageToast("正在准备导出 ZIP...");
    const params = new URLSearchParams({ output_root: outputRoot, name: editorNameValue() });
    const response = await fetch(`/api/export_zip?${params.toString()}`);
    const text = await response.text();
    if (!response.ok) {
      try {
        const data = JSON.parse(text);
        throw new Error(data.error || text);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(text);
        throw error;
      }
    }
    const result = JSON.parse(text);
    finishStageToast("ZIP 已导出到本地");
    setStatus(`已导出 ZIP：${shortenMiddle(result.path, 72)}`);
    window.alert(`导出成功，文件已保存到：\n${result.path}`);
  } catch (error) {
    finishStageToast(error.message || String(error), true);
    setStatus(error.message || String(error), true);
  }
}

async function importReviewRecords(file) {
  if (!file) return;
  try {
    showStageToast("正在导入审核文件...");
    const text = await file.text();
    const records = JSON.parse(text);
    const result = await postJson("/api/import_review_records", {
      output: outputPayload(),
      records,
    });
    await refreshSamplesPreservingCurrent(appState.data?.annotation_path || appState.selectedSample?.annotation_path);
    const state = await getJson("/api/state");
    renderState(state);
    finishStageToast(`审核文件导入完成：合并 ${result.merged} 个样本`);
    const checkText = operationCheckText("审核文件字段自检", result.review_check);
    const historyText = result.history?.dir ? `；归档：${shortenMiddle(result.history.dir, 72)}` : "";
    setStatus(`${checkText}；已导入审核文件，合并 ${result.merged} 个重复样本，跳过 ${result.skipped} 个${historyText}。`, result.review_check?.summary?.status === "error");
  } catch (error) {
    finishStageToast(error.message || String(error), true);
    setStatus(error.message || String(error), true);
  } finally {
    if ($("reviewFileInput")) $("reviewFileInput").value = "";
  }
}

function nudge(axis, delta) {
  const beforeSnapshot = positionSnapshot();
  const step = numberValue("stepSize");
  const target = $(axisInputs[axis]);
  target.value = (Number(target.value || 0) + Number(delta) * step).toFixed(6);
  syncSelectedFromInputs();
  pushPositionHistory(beforeSnapshot);
  resetMoveSliders();
  markDirty();
  scheduleAnchorSnap();
}

async function applySampleFilters() {
  const preferred = appState.selectedSample?.annotation_path || appState.data?.annotation_path || "";
  const selected = renderSampleOptions(preferred);
  if (selected) {
    selectSample(selected.annotation_path);
    await loadAnnotation();
  } else {
    appState.selectedSample = null;
    $("sampleTitle").textContent = "当前筛选无样本";
    setPathInputValue("annotationPath", "");
    setPathInputValue("objPath", "");
    setStatus("当前筛选条件下没有样本。", true);
  }
}

function initEvents() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("mediaModal")?.hidden) closeMediaModal();
  });
  $("refreshSamples").addEventListener("click", () => refreshSamples({ autoLoad: true }));
  $("refreshLogBtn")?.addEventListener("click", refreshBackendLog);
  $("sampleStatusFilter")?.addEventListener("change", applySampleFilters);
  $("sampleRatingFilter")?.addEventListener("change", applySampleFilters);
  $("sampleSelect").addEventListener("change", async (event) => {
    selectSample(event.target.value);
    await loadAnnotation();
  });
  $("loadBtn").addEventListener("click", () => loadAnnotation({ startFromOutput: false }));
  $("loadAdjustedBtn")?.addEventListener("click", () => loadAnnotation({ startFromOutput: true }));
  $("undoBtn")?.addEventListener("click", undoPosition);
  $("redoBtn")?.addEventListener("click", redoPosition);
  $("renderBtn").addEventListener("click", () => renderProjection("/api/render"));
  $("saveBtn").addEventListener("click", () => renderProjection("/api/save"));
  $("exportZipBtn")?.addEventListener("click", downloadExportZip);
  $("importReviewBtn")?.addEventListener("click", () => $("reviewFileInput")?.click());
  $("reviewFileInput")?.addEventListener("change", (event) => importReviewRecords(event.target.files?.[0]));
  $("objOSourceSelect")?.addEventListener("change", (event) => {
    appState.objOSource = event.target.value;
    updateObjOUpdateHint();
    updateObjOViewSelect(appState.data);
    refreshObjOPreview(appState.data, true);
  });
  $("objOViewSelect")?.addEventListener("change", (event) => {
    appState.objOView = event.target.value;
    refreshObjOPreview(appState.data, true);
    updateSaveButtons(appState.data);
  });
  $("resetObjOViewBtn")?.addEventListener("click", () => window.resetObjOView?.());
  $("targetSelect").addEventListener("change", (event) => selectTarget(Number(event.target.value)));
  for (const radio of document.querySelectorAll('input[name="targetKind"]')) {
    radio.addEventListener("change", (event) => selectTargetKind(event.target.value));
  }

  for (const id of ["camX", "camY", "camZ"]) {
    $(id).addEventListener("focus", beginPositionHistory);
    $(id).addEventListener("input", () => {
      beginPositionHistory();
      syncSelectedFromInputs();
      resetMoveSliders();
      markDirty();
      scheduleAnchorSnap();
    });
    $(id).addEventListener("change", commitPositionHistory);
    $(id).addEventListener("blur", commitPositionHistory);
  }
  $("stepSize").addEventListener("input", renderViewGuides);
  $("outputRoot").addEventListener("input", () => markDirty(false));
  $("editorName").addEventListener("input", () => {
    markDirty(false);
    updateSaveButtons(appState.data);
  });
  $("selfRating")?.addEventListener("change", () => {
    markDirty(false);
    updateSaveButtons(appState.data);
  });
  $("adjusterRemark")?.addEventListener("input", () => markDirty(false));
  for (const button of document.querySelectorAll(".axis-step[data-axis]")) {
    button.addEventListener("click", () => nudge(Number(button.dataset.axis), Number(button.dataset.delta)));
  }
  for (const id of sliderIds) {
    const slider = $(id);
    if (!slider) continue;
    slider.addEventListener("pointerdown", () => {
      beginPositionHistory();
      primeMoveSlider(slider);
    });
    slider.addEventListener("focus", () => {
      beginPositionHistory();
      primeMoveSlider(slider);
    });
    slider.addEventListener("input", () => applyMoveSlider(slider));
    slider.addEventListener("change", () => finishMoveSlider(slider));
    slider.addEventListener("pointerup", () => finishMoveSlider(slider));
    slider.addEventListener("blur", () => finishMoveSlider(slider));
  }
}

async function init() {
  placeActionButtons();
  bindPathInputs();
  addFullscreenButtons();
  initEvents();
  startBackendLogPolling();
  try {
    const defaults = await getJson("/api/defaults");
    setPathInputValue("datasetRoot", defaults.dataset_root || "");
    setPathInputValue("outputRoot", defaults.output_root || defaults.dataset_root || "");
    await refreshSamples();
    if (appState.selectedSample) {
      await loadAnnotation();
    } else {
      const data = await getJson("/api/state");
      renderState(data, { resetHistory: true });
    }
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

init();
