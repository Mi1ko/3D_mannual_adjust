const adminState = {
  submissions: [],
  submission: ".",
  data: null,
  index: 0,
  objView: "main",
  statusFilter: "all",
};

const selfRatingLabels = { good: "好", medium: "中", bad: "差", unknown: "未知" };
const reviewRatingLabels = { good: "优", medium: "中", bad: "差", unknown: "未知" };
const sampleStatusLabels = {
  "": "待微调",
  adjusted: "已微调待审核",
  changes_required: "已审核待修改",
  reviewed: "已审核为优",
};
const imageIds = {
  main: "adminImgMain",
  up: "adminImgUp",
  down: "adminImgDown",
  left: "adminImgLeft",
  right: "adminImgRight",
};

const $ = (id) => document.getElementById(id);

function projectPathDisplay(value) {
  const text = String(value || "");
  const normalized = text.replace(/\//g, "\\");
  const marker = "manual_adjust_app";
  const index = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
  return index >= 0 ? `……\\${normalized.slice(index)}` : normalized;
}

function shortenMiddle(value, maxLength = 58) {
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

function fileUrl(path) {
  return `/api/file?path=${encodeURIComponent(path)}&t=${Date.now()}`;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error);
  return data;
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
  const node = $("adminStatus");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("error", Boolean(isError));
}

function currentSample() {
  return adminState.data?.current || null;
}

function selectedSubmission() {
  return $("submissionSelect")?.value || adminState.submission || ".";
}

function selectedStatusFilter() {
  return $("adminStatusFilter")?.value || adminState.statusFilter || "all";
}

function statusLabelForSample(sample) {
  return sample?.status_label || sampleStatusLabels[sample?.status || ""] || "待微调";
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
  const title = card.querySelector("header")?.childNodes?.[0]?.textContent?.trim() || "投影预览";
  const body = openMediaModal(title);
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
  document.querySelectorAll(".admin-image-card, .admin-obj-panel").forEach((card) => {
    const header = card.querySelector(":scope > header");
    if (!header || header.querySelector(".fullscreen-btn")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fullscreen-btn";
    button.title = "放大";
    button.setAttribute("aria-label", "放大");
    button.addEventListener("click", () => {
      if (card.classList.contains("admin-obj-panel")) openObjModal(card);
      else openImageModal(card);
    });
    header.appendChild(button);
  });
}

function historyLabelForItem(item) {
  if (!item) return "-";
  if (item.actor === "admin" && item.rating) {
    return item.rating === "good" ? sampleStatusLabels.reviewed : sampleStatusLabels.changes_required;
  }
  if (item.event === "reviewed" || item.event === "rechecked") return sampleStatusLabels.reviewed;
  if (item.event === "changes_required") return sampleStatusLabels.changes_required;
  if (item.event === "adjusted" || item.event === "pending_recheck") return sampleStatusLabels.adjusted;
  return item.label || item.event || "-";
}

function populateSubmissions(data, preferredSubmission = adminState.submission) {
  adminState.submissions = data.submissions || [];
  const select = $("submissionSelect");
  select.innerHTML = "";
  for (const submission of adminState.submissions) {
    const option = document.createElement("option");
    option.value = submission.name;
    const adjuster = submission.adjusters?.length ? submission.adjusters.join(", ") : "";
    option.textContent = `${submission.display_name} | 已审 ${submission.reviewed_count}/${submission.total}`;
    if (adjuster) option.title = `微调者：${adjuster}`;
    select.appendChild(option);
  }
  if (adminState.submissions.length) {
    const names = adminState.submissions.map((submission) => submission.name);
    adminState.submission = names.includes(preferredSubmission) ? preferredSubmission : adminState.submissions[0].name;
    select.value = adminState.submission;
  }
}

async function loadSubmissions(options = {}) {
  const { autoload = true, preferredSubmission = adminState.submission } = options;
  const data = await getJson("/api/admin/submissions");
  populateSubmissions(data, preferredSubmission);
  if (!adminState.submissions.length) {
    setStatus("data/admin/pending 下没有找到带 manual_adjust_records.json 的提交包", true);
    renderEmpty();
    return;
  }
  if (autoload) await loadSample(0);
}

async function loadSample(index = adminState.index, key = "") {
  adminState.submission = selectedSubmission();
  adminState.statusFilter = selectedStatusFilter();
  const params = new URLSearchParams({
    submission: adminState.submission,
    index: String(index),
    status_filter: adminState.statusFilter,
  });
  if (key) params.set("key", key);
  const data = await getJson(`/api/admin/sample?${params.toString()}`);
  adminState.data = data;
  adminState.index = data.index || 0;
  renderAdminState();
}

function renderEmpty() {
  $("progressText").textContent = "-";
  $("sampleCounter").textContent = "-";
  $("adminSampleTitle").textContent = "未加载";
  document.querySelector(".admin-sample-title")?.classList.remove("reviewed-sample");
  const hint = $("adminReviewedHint");
  if (hint) {
    hint.hidden = true;
    hint.textContent = "";
  }
  renderSampleJump(null);
  $("adjusterName").textContent = "-";
  $("selfRatingText").textContent = "-";
  $("reviewStatusText").textContent = "待微调";
  $("selfRemarkText").textContent = "-";
  renderValidation(null);
  $("adminRating").value = "";
  $("adminRemark").value = "";
  $("saveReviewBtn").disabled = true;
  $("prevSampleBtn").disabled = true;
  $("nextSampleBtn").disabled = true;
  for (const id of Object.values(imageIds)) $(id)?.removeAttribute("src");
  window.clearObjOPreview?.();
}

function renderImages(sample) {
  const images = sample?.projection_images || {};
  for (const [view, id] of Object.entries(imageIds)) {
    const img = $(id);
    if (!img) continue;
    if (images[view]) img.src = fileUrl(images[view]);
    else img.removeAttribute("src");
  }
}

function renderSampleJump(data, currentKey = "") {
  const select = $("adminSampleSelect");
  if (!select) return;
  const samples = Array.isArray(data?.all_samples) ? data.all_samples : Array.isArray(data?.samples) ? data.samples : [];
  select.innerHTML = "";
  select.disabled = !samples.length;
  for (const [index, sample] of samples.entries()) {
    const option = document.createElement("option");
    option.value = sample.key;
    const status = statusLabelForSample(sample);
    option.textContent = `${index + 1}. ${sample.category}/${sample.sample_id} · ${status}`;
    select.appendChild(option);
  }
  if (currentKey) select.value = currentKey;
}

function renderValidation(sample) {
  const summaryNode = $("validationSummary");
  const listNode = $("validationList");
  if (!summaryNode || !listNode) return;
  const validation = sample?.validation || {};
  const summary = validation.summary || {};
  const issues = Array.isArray(validation.issues) ? validation.issues : [];
  summaryNode.textContent = summary.label || "-";
  summaryNode.className = summary.status || "";
  listNode.innerHTML = "";
  if (!issues.length) {
    const empty = document.createElement("div");
    empty.className = "validation-item info";
    empty.textContent = "暂无校验结果";
    listNode.appendChild(empty);
    return;
  }
  for (const issue of issues.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = `validation-item ${issue.level || "info"}`;
    const title = document.createElement("strong");
    title.textContent = issue.title || "-";
    item.appendChild(title);
    if (issue.detail || issue.path) {
      const detail = document.createElement("span");
      detail.textContent = [issue.detail, issue.path ? shortenMiddle(issue.path, 66) : ""].filter(Boolean).join(" | ");
      if (issue.path) detail.title = issue.path;
      item.appendChild(detail);
    }
    listNode.appendChild(item);
  }
  if (issues.length > 8) {
    const more = document.createElement("div");
    more.className = "validation-item info";
    more.textContent = `还有 ${issues.length - 8} 条校验信息`;
    listNode.appendChild(more);
  }
}

function renderHistory(sample) {
  const node = $("historyList");
  if (!node) return;
  const history = (sample?.history || []).slice(-6).reverse();
  node.innerHTML = history
    .map((item) => {
      const cycle = Number(item.cycle || 0) > 0 ? ` #${item.cycle}` : "";
      const labels = item.actor === "admin" ? reviewRatingLabels : selfRatingLabels;
      const rating = item.rating ? ` · ${labels[item.rating] || item.rating}` : "";
      const label = historyLabelForItem(item);
      return `<div><strong>${label}${label === (item.event || "") ? cycle : ""}</strong><span>${item.at || ""}${rating}</span></div>`;
    })
    .join("");
}

function refreshObjPreview() {
  const sample = currentSample();
  if (!sample || !window.loadObjOPreview) return;
  const view = $("adminObjViewSelect")?.value || adminState.objView || "main";
  adminState.objView = view;
  window.loadObjOPreview(
    {
      obj_o_sources: sample.obj_o_sources || {},
      obj_o_default_source: "output",
      camera: sample.camera || null,
      view_cameras: sample.view_cameras || {},
    },
    { force: true, source: "output", view },
  );
}

function renderAdminState() {
  const data = adminState.data;
  const sample = currentSample();
  if (!sample) {
    renderEmpty();
    if (data) {
      const overallTotal = data.overall_total ?? data.total ?? 0;
      $("progressText").textContent = `已审查 ${data.reviewed_count || 0} / ${overallTotal}`;
      setStatus("当前状态筛选下没有样本，可通过样本状态切换到全部样本。", true);
    }
    return;
  }
  const overallTotal = data.overall_total ?? data.total ?? 0;
  $("progressText").textContent = `已审查 ${data.reviewed_count || 0} / ${overallTotal}`;
  $("sampleCounter").textContent = `${(data.index || 0) + 1} / ${data.total || 0}`;
  $("adminSampleTitle").textContent = `${sample.category} / ${sample.sample_id}`;
  const statusLabel = statusLabelForSample(sample);
  const titleBox = document.querySelector(".admin-sample-title");
  titleBox?.classList.toggle("reviewed-sample", !sample.needs_review);
  const hint = $("adminReviewedHint");
  if (hint) {
    hint.hidden = Boolean(sample.needs_review);
    hint.textContent = sample.needs_review ? "" : `${statusLabel}，可重新保存审核`;
  }
  $("adjusterName").textContent = sample.adjuster?.name || sample.adjuster_name || "-";
  $("selfRatingText").textContent = sample.adjuster?.rating_label || selfRatingLabels[sample.self_rating] || "-";
  $("reviewStatusText").textContent = statusLabel;
  $("selfRemarkText").textContent = sample.adjuster?.remark || "无";
  $("adminRating").value = sample.review?.rating || "";
  $("adminRemark").value = sample.review?.remark || "";
  $("saveReviewBtn").disabled = false;
  $("saveReviewBtn").title = sample.needs_review ? "保存审核信息" : `${statusLabel}，可重新保存审核`;
  $("prevSampleBtn").disabled = (data.index || 0) <= 0;
  $("nextSampleBtn").disabled = (data.index || 0) >= (data.total || 1) - 1;
  renderSampleJump(data, sample.key);
  renderImages(sample);
  renderValidation(sample);
  renderHistory(sample);
  refreshObjPreview();
  setStatus(sample.needs_review ? "待审核" : `${statusLabel}，可重新保存审核`);
}

async function saveReview() {
  const sample = currentSample();
  if (!sample) return;
  const rating = $("adminRating").value;
  if (!rating) {
    $("adminRating").focus();
    setStatus("请先选择审核评价。", true);
    return;
  }
  try {
    setStatus("正在保存审核...");
    const submission = selectedSubmission();
    await postJson("/api/admin/review", {
      submission,
      sample_key: sample.key,
      reviewer_name: $("reviewerName").value.trim(),
      admin_rating: rating,
      admin_remark: $("adminRemark").value.trim(),
      status_filter: "all",
      review_mode: "view",
    });
    await loadSubmissions({ autoload: false, preferredSubmission: submission });
    await loadSample(0, sample.key);
    setStatus("审核已保存，仍停留在当前样本。");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function exportReviewRecords() {
  const params = new URLSearchParams({ submission: selectedSubmission() });
  try {
    setStatus("正在导出审核文件...");
    const result = await getJson(`/api/admin/export_records?${params.toString()}`);
    setStatus(`审核文件已导出：${shortenMiddle(result.path, 72)}`);
    window.alert(`导出成功，文件已保存到：\n${result.path}`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function initEvents() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("mediaModal")?.hidden) closeMediaModal();
  });
  $("submissionSelect").addEventListener("change", async (event) => {
    adminState.submission = event.target.value;
    await loadSample(0);
  });
  $("adminStatusFilter").addEventListener("change", async (event) => {
    adminState.statusFilter = event.target.value;
    await loadSample(0);
  });
  $("prevSampleBtn").addEventListener("click", () => loadSample(Math.max(0, adminState.index - 1)));
  $("nextSampleBtn").addEventListener("click", () => loadSample(adminState.index + 1));
  $("adminSampleSelect").addEventListener("change", (event) => loadSample(adminState.index, event.target.value));
  $("saveReviewBtn").addEventListener("click", saveReview);
  $("exportReviewBtn").addEventListener("click", exportReviewRecords);
  $("adminObjViewSelect").addEventListener("change", refreshObjPreview);
  $("adminResetObjBtn").addEventListener("click", () => window.resetObjOView?.());
}

window.addEventListener("obj-o-viewer-ready", refreshObjPreview);

async function init() {
  addFullscreenButtons();
  initEvents();
  try {
    await loadSubmissions();
  } catch (error) {
    setStatus(error.message || String(error), true);
    renderEmpty();
  }
}

init();
