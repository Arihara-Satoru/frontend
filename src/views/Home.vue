<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import api from "../utils/http";

// 推理页统一承载图片、视频和摄像头三种识别方式，核心是复用同一套模型与设备选择状态。
const loadingSystem = ref(false);
const deviceInfo = ref(null);
const modelList = ref([]);

const selectedModel = ref("yolov8n");
const selectedDevice = ref("auto");
const conf = ref(0.35);

const imageFile = ref(null);
const imageResult = ref(null);
const imageLoading = ref(false);
const imageRequestMs = ref(null);

const videoFile = ref(null);
const videoRunning = ref(false);
const videoFrame = ref("");
const videoMetrics = ref(null);
const videoLoading = ref(false);
const videoPollingBusy = ref(false);
const videoPollTimer = ref(null);
const videoFinished = ref(false);

const cameraRunning = ref(false);
const cameraFrame = ref("");
const cameraMetrics = ref(null);
const cameraLoading = ref(false);

const pollTimer = ref(null);
const pollBusy = ref(false);
const lastAlarmAt = ref(0);

// 只展示当前已存在的模型，避免把不可用权重混进下拉框。
const availableModels = computed(() =>
  modelList.value.filter((item) => item.exists),
);

// 当用户选择“自动优先设备”时，真正传给后端的是后端检测出的默认设备。
const effectiveSelectedDevice = computed(() => {
  if (selectedDevice.value === "auto") {
    return deviceInfo.value?.selected_device || "cpu";
  }
  return selectedDevice.value;
});

// 这是本页本地缓存的存储键，用来恢复模型、设备和阈值设置。
const HOME_INFERENCE_STORAGE_KEY = "home_inference_state_v1";

function readHomeInferenceCache() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(HOME_INFERENCE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("读取推理页缓存失败", error);
    return null;
  }
}

function writeHomeInferenceCache(payload) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      HOME_INFERENCE_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch (error) {
    console.warn("写入推理页缓存失败", error);
    // 从本地缓存回填页面状态时，只接受能通过校验的字段，避免旧配置覆盖当前选择。
  }
}

function toBoundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function applyHomeInferenceCache(cached) {
  if (!cached || typeof cached !== "object") {
    return;
  }

  if (typeof cached.selectedModel === "string" && cached.selectedModel.trim()) {
    selectedModel.value = cached.selectedModel.trim();
  }

  if (
    typeof cached.selectedDevice === "string" &&
    cached.selectedDevice.trim()
  ) {
    selectedDevice.value = cached.selectedDevice.trim();
  }

  conf.value = toBoundedNumber(cached.conf, conf.value, 0.1, 0.9);
}

// 页面状态变化后持续写回缓存，刷新页面时可以无感恢复上次设置。
function persistHomeInferenceCache() {
  writeHomeInferenceCache({
    selectedModel: selectedModel.value,
    selectedDevice: selectedDevice.value,
    conf: Number(conf.value),
    savedAt: Date.now(),
  });
}

// 设备文案只负责把后端返回的设备状态转成人类可读标签。
const deviceText = computed(() => {
  if (!deviceInfo.value) return "未知设备";
  if (deviceInfo.value.selected_device?.startsWith("cuda")) {
    return `GPU (${deviceInfo.value.gpu_name || "CUDA"})`;
  }
  return "CPU";
});

// 启动时一次性拉取可用设备和模型列表，并把当前选择修正到可用范围内。
async function loadSystemInfo() {
  loadingSystem.value = true;
  const preferredModel = selectedModel.value;
  const preferredDevice = selectedDevice.value;

  try {
    const [deviceRes, modelsRes] = await Promise.all([
      api.get("/system/device"),
      api.get("/system/models"),
    ]);

    deviceInfo.value = deviceRes.data.data;
    modelList.value = modelsRes.data.data;

    const autoDevice = deviceInfo.value?.selected_device || "cpu";
    const supportedDevices = ["auto", "cpu", autoDevice];
    if (deviceInfo.value?.cuda_available) {
      supportedDevices.push("cuda:0");
    }

    selectedDevice.value = supportedDevices.includes(preferredDevice)
      ? preferredDevice
      : "auto";

    if (
      availableModels.value.length > 0 &&
      !availableModels.value.some((m) => m.id === preferredModel)
    ) {
      selectedModel.value = availableModels.value[0].id;
    } else if (availableModels.value.length > 0) {
      const matched = availableModels.value.find(
        (m) => m.id === preferredModel,
      );
      selectedModel.value = matched?.id || availableModels.value[0].id;
    }
  } catch (error) {
    alert(`系统信息加载失败: ${error.message}`);
  } finally {
    loadingSystem.value = false;
  }
}

// 文件输入只负责更新响应式状态，真正推理交给后面的按钮逻辑。
function onImageFileChange(event) {
  imageFile.value = event.target.files?.[0] || null;
  imageResult.value = null;
  imageRequestMs.value = null;
}

function onVideoFileChange(event) {
  videoFile.value = event.target.files?.[0] || null;
  videoFrame.value = "";
  videoMetrics.value = null;
  videoFinished.value = false;
}

// 视频和摄像头轮询都依赖定时器，这两个辅助函数负责避免重复创建多个定时器。
function clearVideoPollingTimer() {
  if (videoPollTimer.value) {
    clearInterval(videoPollTimer.value);
    videoPollTimer.value = null;
  }
}

// 如果当前正在运行视频识别，才允许挂起一个新的轮询任务。
function ensureVideoPollingTimer() {
  if (videoPollTimer.value || !videoRunning.value) {
    return;
  }
  videoPollTimer.value = setInterval(fetchVideoFrame, 130);
}

// 摄像头轮询同样只保留一个活动定时器，避免状态切换时重复拉帧。
function clearCameraPollingTimer() {
  if (pollTimer.value) {
    clearInterval(pollTimer.value);
    pollTimer.value = null;
  }
}

// 摄像头运行时才启动轮询，和视频模式保持同样的节流逻辑。
function ensureCameraPollingTimer() {
  if (pollTimer.value || !cameraRunning.value) {
    return;
  }
  pollTimer.value = setInterval(fetchCameraFrame, 260);
}

// 图片识别是一次性请求，结果会直接回填到图像和指标卡片里。
async function runImageInference() {
  if (!imageFile.value) {
    alert("请先选择图片文件");
    return;
  }

  imageLoading.value = true;
  const requestStartedAt = performance.now();
  try {
    const form = new FormData();
    form.append("file", imageFile.value);
    form.append("model_name", selectedModel.value);
    form.append("conf", String(conf.value));
    form.append("device", effectiveSelectedDevice.value);

    const response = await api.post("/inference/image", form);
    imageResult.value = response.data.data;
    imageRequestMs.value = Number(
      (performance.now() - requestStartedAt).toFixed(2),
    );
  } catch (error) {
    alert(`图片识别失败: ${error.message}`);
  } finally {
    imageLoading.value = false;
  }
}

const imageModelInferenceMs = computed(
  () => imageResult.value?.metrics?.inference_ms ?? null,
);

const imageOverheadMs = computed(() => {
  if (imageRequestMs.value == null || imageModelInferenceMs.value == null) {
    return null;
  }

  return Math.max(
    0,
    Number((imageRequestMs.value - imageModelInferenceMs.value).toFixed(2)),
  );
});

// 视频识别先启动后端任务，再通过轮询不断取回最新帧。
async function runVideoInference() {
  if (!videoFile.value) {
    alert("请先选择视频文件");
    return;
  }

  videoLoading.value = true;
  try {
    const form = new FormData();
    form.append("file", videoFile.value);
    form.append("model_name", selectedModel.value);
    form.append("conf", String(conf.value));
    form.append("device", effectiveSelectedDevice.value);

    await api.post("/inference/video/start", form);
    videoRunning.value = true;
    videoFinished.value = false;
    videoFrame.value = "";
    videoMetrics.value = null;

    clearVideoPollingTimer();
    ensureVideoPollingTimer();
    await fetchVideoFrame();
  } catch (error) {
    alert(`视频实时识别失败: ${error.message}`);
  } finally {
    videoLoading.value = false;
  }
}

// 拉取视频帧时要处理“正常更新”和“后端已结束/未启动”这两类状态。
async function fetchVideoFrame() {
  if (!videoRunning.value || videoPollingBusy.value) {
    return;
  }

  videoPollingBusy.value = true;
  try {
    const response = await api.get("/inference/video/frame");
    const payload = response.data.data;
    videoFrame.value = payload.frame;
    videoMetrics.value = payload.metrics;

    if (payload.metrics?.alarm) {
      triggerAlarm(payload.alarm_audio_url);
    }
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;

    if (status === 409 && /结束|停止/.test(message)) {
      videoFinished.value = true;
      await stopVideoInference(true, false);
      return;
    }

    if (status === 409 && /未启动/.test(message)) {
      await stopVideoInference(true, false);
      return;
    }

    console.error(error);
  } finally {
    videoPollingBusy.value = false;
  }
}

// 停止视频识别时既要清理前端定时器，也要通知后端结束任务。
async function stopVideoInference(silent = false, syncBackend = true) {
  clearVideoPollingTimer();

  if (syncBackend) {
    try {
      await api.post("/inference/video/stop");
    } catch (error) {
      if (!silent) {
        console.error(error);
      }
    }
  }

  videoRunning.value = false;
}

// 报警音做了节流，避免连续多帧触发时声音重叠。
function triggerAlarm(audioUrl) {
  const now = Date.now();
  if (now - lastAlarmAt.value < 1500) {
    return;
  }
  lastAlarmAt.value = now;

  const player = new Audio(audioUrl || "/static/audio/alert.wav");
  player.play().catch(() => {
    // 浏览器可能因为自动播放策略阻止声音，这里静默处理避免打断流程
  });
}

// 摄像头轮询和视频轮询一致，只是数据源从视频帧接口换成摄像头接口。
async function fetchCameraFrame() {
  if (!cameraRunning.value || pollBusy.value) {
    return;
  }

  pollBusy.value = true;
  try {
    const response = await api.get("/inference/camera/frame");
    const payload = response.data.data;
    cameraFrame.value = payload.frame;
    cameraMetrics.value = payload.metrics;

    if (payload.metrics?.alarm) {
      triggerAlarm(payload.alarm_audio_url);
    }
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    if (status === 409 && /未启动|停止/.test(message)) {
      await stopCamera(true, false);
      return;
    }
    console.error(error);
  } finally {
    pollBusy.value = false;
  }
}

// 启动摄像头前先把当前模型、设备和阈值发给后端，确保后端以页面当前选择为准。
async function startCamera() {
  cameraLoading.value = true;
  try {
    await api.post("/inference/camera/start", {
      source: 0,
      model_name: selectedModel.value,
      conf: conf.value,
      device: effectiveSelectedDevice.value,
    });

    cameraRunning.value = true;
    cameraFrame.value = "";
    cameraMetrics.value = null;

    clearCameraPollingTimer();
    ensureCameraPollingTimer();
    await fetchCameraFrame();
  } catch (error) {
    alert(`启动实时识别失败: ${error.message}`);
  } finally {
    cameraLoading.value = false;
  }
}

// 停止摄像头时同样清理轮询和后端状态。
async function stopCamera(silent = false, syncBackend = true) {
  clearCameraPollingTimer();

  if (syncBackend) {
    try {
      await api.post("/inference/camera/stop");
    } catch (error) {
      if (!silent) {
        console.error(error);
      }
    }
  }

  cameraRunning.value = false;
}

// 页面切换回来时主动同步一次后端推理状态，防止本地和服务端状态漂移。
async function syncInferenceRuntimeStatus() {
  try {
    const response = await api.get("/inference/status");
    const statusData = response.data.data || {};
    const videoStatus = statusData.video || {};
    const cameraStatus = statusData.camera || {};

    videoRunning.value = Boolean(videoStatus.running);
    cameraRunning.value = Boolean(cameraStatus.running);

    if (!videoRunning.value) {
      clearVideoPollingTimer();
      videoPollingBusy.value = false;
    } else {
      videoFinished.value = false;
      ensureVideoPollingTimer();
      await fetchVideoFrame();
    }

    if (!cameraRunning.value) {
      clearCameraPollingTimer();
      pollBusy.value = false;
    } else {
      ensureCameraPollingTimer();
      await fetchCameraFrame();
    }
  } catch (error) {
    console.error("同步后端推理状态失败", error);
  }
}

// 标签页切回可见时重新同步状态，避免后台任务运行中却显示旧页面状态。
function handleDocumentVisibilityChange() {
  if (document.visibilityState === "visible") {
    syncInferenceRuntimeStatus();
  }
}

// 只要模型、设备或阈值变化，就把最新选择保存下来，下一次进入页面可以直接恢复。
watch(
  [selectedModel, selectedDevice, conf],
  () => {
    persistHomeInferenceCache();
  },
  { deep: true },
);

// 挂载后先恢复本地缓存，再同步系统与后端运行态，最后注册页面可见性监听。
onMounted(async () => {
  const cached = readHomeInferenceCache();
  applyHomeInferenceCache(cached);
  await loadSystemInfo();
  await syncInferenceRuntimeStatus();

  if (typeof document !== "undefined") {
    document.addEventListener(
      "visibilitychange",
      handleDocumentVisibilityChange,
    );
  }
});

// 卸载前保存状态并清理定时器，避免离开页面后继续占用轮询资源。
onUnmounted(() => {
  persistHomeInferenceCache();
  clearVideoPollingTimer();
  clearCameraPollingTimer();

  if (typeof document !== "undefined") {
    document.removeEventListener(
      "visibilitychange",
      handleDocumentVisibilityChange,
    );
  }
});
</script>

<template>
  <div class="card-panel p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="section-title">识别中心</h2>
        <p class="section-subtitle">
          调用本地 YOLO 模型执行图片、视频实时识别和摄像头实时识别
        </p>
      </div>
      <div class="metric-chip">当前计算设备: {{ deviceText }}</div>
    </div>

    <div
      class="mt-4 grid gap-3 rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4 md:grid-cols-4"
    >
      <div>
        <label class="field-label">模型</label>
        <select
          v-model="selectedModel"
          class="field-input"
          :disabled="loadingSystem"
        >
          <option
            v-for="item in availableModels"
            :key="item.id"
            :value="item.id"
          >
            {{ item.display_name }}
          </option>
        </select>
      </div>

      <div>
        <label class="field-label">设备</label>
        <select v-model="selectedDevice" class="field-input">
          <option value="auto">自动优先设备</option>
          <option value="cpu">cpu</option>
          <option value="cuda:0" :disabled="!deviceInfo?.cuda_available">
            cuda:0
          </option>
        </select>
      </div>

      <div>
        <label class="field-label">置信度阈值: {{ conf.toFixed(2) }}</label>
        <input
          v-model.number="conf"
          type="range"
          min="0.1"
          max="0.9"
          step="0.01"
          class="w-full"
        />
      </div>

      <div class="flex items-end">
        <button
          class="btn-secondary w-full"
          @click="loadSystemInfo"
          :disabled="loadingSystem"
        >
          {{ loadingSystem ? "加载中..." : "刷新设备与模型" }}
        </button>
      </div>
    </div>
  </div>

  <div class="space-y-5">
    <section class="card-panel p-5">
      <div class="grid gap-4 lg:grid-cols-[1.45fr_0.85fr] lg:items-start">
        <div class="space-y-3">
          <h3 class="section-title">图片识别</h3>
          <p class="section-subtitle mt-1">
            框选高置信度车辆，并输出前车距离/速度/TTC
          </p>
          <div
            class="overflow-hidden rounded-2xl border border-[var(--line-soft)] bg-black/90"
          >
            <img
              v-if="imageResult"
              :src="imageResult.image"
              alt="image-result"
              class="w-full"
            />
            <div
              v-else
              class="flex h-[280px] items-center justify-center text-sm text-white/75"
            >
              尚未开始图片识别
            </div>
          </div>
        </div>

        <div class="space-y-3 lg:pt-11">
          <input
            type="file"
            accept="image/*"
            @change="onImageFileChange"
            class="field-input"
          />
          <div
            class="rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4"
          >
            <div class="text-sm font-semibold text-[var(--text-strong)]">
              识别操作
            </div>
            <div class="mt-2 text-sm text-[var(--text-muted)]">
              先选择图片，再点击按钮开始识别。
            </div>
            <div class="mt-4 flex flex-col gap-2">
              <button
                class="btn-primary w-full"
                @click="runImageInference"
                :disabled="imageLoading"
              >
                {{ imageLoading ? "识别中..." : "开始图片识别" }}
              </button>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              <div class="metric-chip">
                车辆数: {{ imageResult?.metrics?.vehicle_count ?? "--" }}
              </div>
              <div class="metric-chip">
                模型推理耗时: {{ imageModelInferenceMs ?? "--" }} ms
              </div>
              <div class="metric-chip">
                请求总耗时: {{ imageRequestMs ?? "--" }} ms
              </div>
              <div class="metric-chip">
                额外开销: {{ imageOverheadMs ?? "--" }} ms
              </div>
              <div class="metric-chip">
                前车距离: {{ imageResult?.metrics?.distance_m ?? "--" }} m
              </div>
              <div v-if="imageResult?.metrics?.alarm" class="alarm-chip">
                TTC 小于 3 秒，触发报警
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="card-panel p-5">
      <div class="grid gap-4 lg:grid-cols-[1.45fr_0.85fr] lg:items-start">
        <div class="space-y-3">
          <h3 class="section-title">视频实时识别</h3>
          <p class="section-subtitle mt-1">
            上传视频后按帧实时识别并显示前车距离、相对速度与 TTC
          </p>
          <div
            class="overflow-hidden rounded-2xl border border-[var(--line-soft)] bg-black/90"
          >
            <img
              v-if="videoFrame"
              :src="videoFrame"
              alt="video-frame"
              class="w-full"
            />
            <div
              v-else
              class="flex h-[280px] items-center justify-center text-sm text-white/75"
            >
              尚未开始视频实时识别
            </div>
          </div>
        </div>

        <div class="space-y-3 lg:pt-11">
          <input
            type="file"
            accept="video/*"
            @change="onVideoFileChange"
            class="field-input"
          />
          <div
            class="rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4"
          >
            <div class="text-sm font-semibold text-[var(--text-strong)]">
              识别操作
            </div>
            <div class="mt-2 text-sm text-[var(--text-muted)]">
              先选择视频，再启动实时识别。
            </div>
            <div class="mt-4 flex flex-col gap-2">
              <button
                class="btn-primary w-full"
                @click="runVideoInference"
                :disabled="videoLoading || videoRunning"
              >
                {{ videoLoading ? "启动中..." : "开始实时识别" }}
              </button>
              <button
                class="btn-secondary w-full"
                @click="stopVideoInference"
                :disabled="!videoRunning"
              >
                停止
              </button>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              <div class="metric-chip">
                运行状态: {{ videoRunning ? "运行中" : "未运行" }}
              </div>
              <div class="metric-chip">
                视频文件: {{ videoFile?.name || "未选择" }}
              </div>
              <div class="metric-chip">
                车辆数量: {{ videoMetrics?.vehicle_count ?? "--" }}
              </div>
              <div class="metric-chip">
                前车距离: {{ videoMetrics?.distance_m ?? "--" }} m
              </div>
              <div class="metric-chip">
                相对速度: {{ videoMetrics?.relative_speed_mps ?? "--" }} m/s
              </div>
              <div class="metric-chip">
                碰撞时间 TTC: {{ videoMetrics?.ttc_seconds ?? "--" }} s
              </div>
              <div class="metric-chip">
                帧推理耗时: {{ videoMetrics?.inference_ms ?? "--" }} ms
              </div>
              <div v-if="videoFinished" class="metric-chip">
                视频播放结束，已停止实时识别
              </div>
              <div v-if="videoMetrics?.alarm" class="alarm-chip">
                警报: TTC 小于 3 秒，已触发 alert.wav
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>

  <section class="card-panel p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 class="section-title">实时识别</h3>
        <p class="section-subtitle mt-1">
          轮询摄像头帧，实时显示前车距离、相对速度与 TTC
        </p>
      </div>
      <div class="flex gap-2">
        <button
          class="btn-primary"
          @click="startCamera"
          :disabled="cameraRunning || cameraLoading"
        >
          {{ cameraLoading ? "启动中..." : "启动实时识别" }}
        </button>
        <button
          class="btn-secondary"
          @click="stopCamera"
          :disabled="!cameraRunning"
        >
          停止
        </button>
      </div>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div
        class="overflow-hidden rounded-2xl border border-[var(--line-soft)] bg-black/90"
      >
        <img
          v-if="cameraFrame"
          :src="cameraFrame"
          alt="camera-frame"
          class="w-full"
        />
        <div
          v-else
          class="flex h-[280px] items-center justify-center text-sm text-white/75"
        >
          尚未开始实时识别
        </div>
      </div>

      <div class="space-y-2">
        <div class="metric-chip">
          运行状态: {{ cameraRunning ? "运行中" : "未运行" }}
        </div>
        <div class="metric-chip">
          车辆数量: {{ cameraMetrics?.vehicle_count ?? "--" }}
        </div>
        <div class="metric-chip">
          前车距离: {{ cameraMetrics?.distance_m ?? "--" }} m
        </div>
        <div class="metric-chip">
          相对速度: {{ cameraMetrics?.relative_speed_mps ?? "--" }} m/s
        </div>
        <div class="metric-chip">
          碰撞时间 TTC: {{ cameraMetrics?.ttc_seconds ?? "--" }} s
        </div>
        <div class="metric-chip">
          帧推理耗时: {{ cameraMetrics?.inference_ms ?? "--" }} ms
        </div>
        <div v-if="cameraMetrics?.alarm" class="alarm-chip">
          警报: TTC 小于 3 秒，已触发 alert.wav
        </div>
      </div>
    </div>
  </section>
</template>
