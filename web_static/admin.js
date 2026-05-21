const adminState = {
  submissions: [],
  submission: ".",
  data: null,
  index: 0,
  objView: "main",
};

const ratingLabels = { good: "好", medium: "中", bad: "差", unknown: "未知" };
const imageIds = {
  main: "adminImgMain",
  up: "adminImgUp",
  down: "adminImgDown",
  left: "adminImgLeft",
  right: "adminImgRight",
};

const $ = (id) => document.getElementById(id);

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
  const params = new URLSearchParams({ submission: adminState.submission, index: String(index) });
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
  renderSampleJump(null);
  $("adjusterName").textContent = "-";
  $("selfRatingText").textContent = "-";
  $("reviewStatusText").textContent = "-";
  $("selfRemarkText").textContent = "-";
  renderValidation(null);
  $("adminRating").value = "";
  $("adminRemark").value = "";
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
  const samples = Array.isArray(data?.samples) ? data.samples : [];
  select.innerHTML = "";
  select.disabled = !samples.length;
  for (const [index, sample] of samples.entries()) {
    const option = document.createElement("option");
    option.value = sample.key;
    const status = sample.status_label || (sample.reviewed ? "已审核" : "待审核");
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
      detail.textContent = [issue.detail, issue.path].filter(Boolean).join(" | ");
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
      const rating = item.rating ? ` · ${ratingLabels[item.rating] || item.rating}` : "";
      return `<div><strong>${item.label || item.event || "-"}${item.label ? "" : cycle}</strong><span>${item.at || ""}${rating}</span></div>`;
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
    return;
  }
  $("progressText").textContent = `已审查 ${data.reviewed_count || 0} / ${data.total || 0}`;
  $("sampleCounter").textContent = `${(data.index || 0) + 1} / ${data.total || 0}`;
  $("adminSampleTitle").textContent = `${sample.category} / ${sample.sample_id}`;
  $("adjusterName").textContent = sample.adjuster?.name || sample.adjuster_name || "-";
  $("selfRatingText").textContent = sample.adjuster?.rating_label || ratingLabels[sample.self_rating] || "-";
  $("reviewStatusText").textContent = sample.status_label || (sample.reviewed ? "已审核" : "待审核");
  $("selfRemarkText").textContent = sample.adjuster?.remark || "无";
  $("adminRating").value = sample.review?.rating || "";
  $("adminRemark").value = sample.review?.remark || "";
  $("prevSampleBtn").disabled = (data.index || 0) <= 0;
  $("nextSampleBtn").disabled = (data.index || 0) >= (data.total || 1) - 1;
  renderSampleJump(data, sample.key);
  renderImages(sample);
  renderValidation(sample);
  renderHistory(sample);
  refreshObjPreview();
  setStatus(sample.needs_review ? "待审核" : "已审核");
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
    const data = await postJson("/api/admin/review", {
      submission,
      sample_key: sample.key,
      reviewer_name: $("reviewerName").value.trim(),
      admin_rating: rating,
      admin_remark: $("adminRemark").value.trim(),
    });
    await loadSubmissions({ autoload: false, preferredSubmission: submission });
    adminState.data = data;
    adminState.index = data.index || 0;
    renderAdminState();
    setStatus("审核已保存。");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function exportReviewRecords() {
  const params = new URLSearchParams({ submission: selectedSubmission() });
  try {
    setStatus("正在导出审核文件...");
    const result = await getJson(`/api/admin/export_records?${params.toString()}`);
    setStatus(`审核文件已导出：${result.path}`);
    window.alert(`导出成功，文件已保存到：\n${result.path}`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function initEvents() {
  $("submissionSelect").addEventListener("change", async (event) => {
    adminState.submission = event.target.value;
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
  initEvents();
  try {
    await loadSubmissions();
  } catch (error) {
    setStatus(error.message || String(error), true);
    renderEmpty();
  }
}

init();
