import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";

const canvas = document.getElementById("objOCanvas");
const empty = document.getElementById("objOEmpty");
const initialZoom = 1.15;

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let currentObject = null;
let resizeObserver = null;
let animationStarted = false;
let loadedPath = "";
let loadedView = "main";
let loadedSource = "input";
let loadedTempStale = false;
let lastData = null;
let initialViewState = null;
let loadSerial = 0;
const sourceLabels = { input: "输入状态", output: "输出状态", temp: "微调中" };
const viewLabels = { main: "主视角", up: "上视角", down: "下视角", left: "左视角", right: "右视角" };

function fileUrl(path) {
  return `/api/file?path=${encodeURIComponent(path)}&t=${Date.now()}`;
}

function setEmpty(message, visible = true) {
  if (!empty) return;
  empty.textContent = message;
  empty.classList.toggle("hidden", !visible);
}

function ensureViewer() {
  if (!canvas) return false;
  if (renderer) return true;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0xf6f8fa, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f8fa);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3ad, 1.7));

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
  keyLight.position.set(2.5, 4.0, 3.0);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.75);
  fillLight.position.set(-3.0, 1.5, -2.5);
  scene.add(fillLight);

  camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  resizeObserver = new ResizeObserver(resizeViewer);
  resizeObserver.observe(canvas.parentElement || canvas);
  resizeViewer();
  startAnimation();
  return true;
}

function resizeViewer() {
  if (!renderer || !camera || !canvas) return;
  const parent = canvas.parentElement || canvas;
  const width = Math.max(1, Math.floor(parent.clientWidth));
  const height = Math.max(1, Math.floor(parent.clientHeight));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function startAnimation() {
  if (animationStarted) return;
  animationStarted = true;
  const animate = () => {
    requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    controls?.update();
    renderer.render(scene, camera);
  };
  animate();
}

function disposeObject(object) {
  object.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      material?.dispose?.();
    }
  });
}

function clearObject() {
  if (!scene || !currentObject) return;
  scene.remove(currentObject);
  disposeObject(currentObject);
  currentObject = null;
  loadedPath = "";
  initialViewState = null;
}

function defaultMaterialize(object) {
  const fallback = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.72, metalness: 0.02 });
  object.traverse((node) => {
    if (!node.isMesh) return;
    if (!node.material) node.material = fallback.clone();
    node.castShadow = false;
    node.receiveShadow = false;
  });
}

function captureViewState() {
  if (!camera || !controls) return null;
  return {
    position: camera.position.clone(),
    up: camera.up.clone(),
    target: controls.target.clone(),
    fov: camera.fov,
    zoom: camera.zoom,
    near: camera.near,
    far: camera.far,
  };
}

function restoreViewState(state = initialViewState) {
  if (!state || !camera || !controls) return;
  camera.position.copy(state.position);
  camera.up.copy(state.up);
  camera.fov = state.fov;
  camera.zoom = state.zoom;
  camera.near = state.near;
  camera.far = state.far;
  controls.target.copy(state.target);
  camera.updateProjectionMatrix();
  controls.update();
}

function applyAnnotationCamera(data, object, viewName = "main") {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-4);
  const sourceCamera = data?.view_cameras?.[viewName] || data?.view_cameras?.main || data?.camera || null;

  if (sourceCamera?.position && sourceCamera?.z_view && sourceCamera?.y_view) {
    const focal = Number(sourceCamera.focal_length_mm || 50);
    const sensorHeight = Number(sourceCamera.sensor_height_mm || 24);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(sensorHeight / (2 * focal)));
    camera.position.fromArray(sourceCamera.position.map(Number));
    camera.up.fromArray(sourceCamera.y_view.map(Number)).normalize();

    const zView = new THREE.Vector3().fromArray(sourceCamera.z_view.map(Number)).normalize();
    const focusDistance = Number(sourceCamera.camera_radius || 10);
    const target = camera.position.clone().sub(zView.multiplyScalar(focusDistance));
    controls.target.copy(target);
  } else {
    const distance = maxDim * 1.45;
    camera.fov = 45;
    camera.position.set(center.x + distance, center.y + distance * 0.72, center.z + distance);
    camera.up.set(0, 1, 0);
    controls.target.copy(center);
  }

  camera.zoom = initialZoom;
  camera.near = Math.max(maxDim / 2000, 0.0001);
  camera.far = Math.max(maxDim * 200, 100);
  camera.updateProjectionMatrix();
  controls.update();
  initialViewState = captureViewState();
}

function loadMtl(url) {
  return new Promise((resolve, reject) => {
    new MTLLoader().load(
      url,
      (materials) => {
        materials.preload();
        resolve(materials);
      },
      undefined,
      reject,
    );
  });
}

function loadObj(url, materials) {
  return new Promise((resolve, reject) => {
    const loader = new OBJLoader();
    if (materials) loader.setMaterials(materials);
    loader.load(url, resolve, undefined, reject);
  });
}

async function loadPreview(data, options = {}) {
  if (!ensureViewer()) return;
  const sourceName = options.source || "input";
  const viewName = options.view || "main";
  const sourceInfo = data?.obj_o_sources?.[sourceName] || (sourceName === "input" ? data : null);
  const objPath = sourceInfo?.paths?.[viewName] || sourceInfo?.path || "";
  const exists = Boolean(sourceInfo?.exists_by_view?.[viewName] ?? sourceInfo?.exists);
  const sourceLabel = sourceLabels[sourceName] || sourceName;
  const viewLabel = viewLabels[viewName] || viewName;
  const serial = ++loadSerial;
  lastData = data || null;
  loadedSource = sourceName;
  loadedView = viewName;
  loadedTempStale = Boolean(options.tempStale);

  if (!objPath || !exists) {
    clearObject();
    const message =
      sourceName === "temp"
        ? "微调中暂无 OBJ-O，请先点击“生成投影”。"
        : `${sourceLabel}暂无 ${viewLabel} OBJ-O。`;
    setEmpty(message, true);
    return;
  }
  if (!options.force && loadedPath === objPath && loadedSource === sourceName && loadedView === viewName && currentObject) {
    setEmpty("", false);
    return;
  }

  setEmpty(`正在加载${sourceLabel} ${viewLabel} OBJ-O...`, true);
  clearObject();

  try {
    let materials = null;
    const mtlPath = sourceInfo?.mtl_path;
    if (mtlPath) {
      materials = await loadMtl(fileUrl(mtlPath));
      if (serial !== loadSerial) return;
    }

    const object = await loadObj(fileUrl(objPath), materials);
    if (serial !== loadSerial) {
      disposeObject(object);
      return;
    }

    currentObject = object;
    defaultMaterialize(currentObject);
    scene.add(currentObject);
    applyAnnotationCamera(data, currentObject, viewName);
    loadedPath = objPath;
    loadedSource = sourceName;
    loadedView = viewName;
    setEmpty("", false);
  } catch (error) {
    if (serial !== loadSerial) return;
    console.error(error);
    clearObject();
    setEmpty(`OBJ-O 加载失败：${error?.message || error}`, true);
  }
}

window.loadObjOPreview = loadPreview;
window.resetObjOView = () => {
  if (currentObject && initialViewState) {
    restoreViewState(initialViewState);
  } else if (lastData) {
    loadPreview(lastData, { force: true, source: loadedSource, view: loadedView, tempStale: loadedTempStale });
  }
};
window.clearObjOPreview = () => {
  ensureViewer();
  loadSerial += 1;
  clearObject();
  setEmpty("请选择 OBJ-O 状态；生成投影后可查看“微调中”。", true);
};

ensureViewer();
window.dispatchEvent(new CustomEvent("obj-o-viewer-ready"));
