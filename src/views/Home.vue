<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import api from "../utils/http";

const loadingSystem = ref(false);
const deviceInfo = ref(null);
const modelList = ref([]);

const selectedModel = ref("yolov8n");
const selectedDevice = ref("cpu");
const conf = ref(0.35);

const imageFile = ref(null);
const imageResult = ref(null);
const imageLoading = ref(false);

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

const availableModels = computed(() =>
  modelList.value.filter((item) => item.exists),
);

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

function persistHomeInferenceCache() {
  writeHomeInferenceCache({
    selectedModel: selectedModel.value,
    selectedDevice: selectedDevice.value,
    conf: Number(conf.value),
    savedAt: Date.now(),
  });
}

const deviceText = computed(() => {
  if (!deviceInfo.value) return "未知设备";
  if (deviceInfo.value.selected_device?.startsWith("cuda")) {
    return `GPU (${deviceInfo.value.gpu_name || "CUDA"})`;
  }
  return "CPU";
});

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
    const supportedDevices = ["cpu", autoDevice];
    if (deviceInfo.value?.cuda_available) {
      supportedDevices.push("cuda:0");
    }

    selectedDevice.value = supportedDevices.includes(preferredDevice)
      ? preferredDevice
      : autoDevice;

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

function onImageFileChange(event) {
  imageFile.value = event.target.files?.[0] || null;
  imageResult.value = null;
}

function onVideoFileChange(event) {
  videoFile.value = event.target.files?.[0] || null;
  videoFrame.value = "";
  videoMetrics.value = null;
  videoFinished.value = false;
}

async function runImageInference() {
  if (!imageFile.value) {
    alert("请先选择图片文件");
    return;
  }

  imageLoading.value = true;
  try {
    const form = new FormData();
    form.append("file", imageFile.value);
    form.append("model_name", selectedModel.value);
    form.append("conf", String(conf.value));
    form.append("device", selectedDevice.value);

    const response = await api.post("/inference/image", form);
    imageResult.value = response.data.data;
  } catch (error) {
    alert(`图片识别失败: ${error.message}`);
  } finally {
    imageLoading.value = false;
  }
}

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
    form.append("device", selectedDevice.value);

    await api.post("/inference/video/start", form);
    videoRunning.value = true;
    videoFinished.value = false;
    videoFrame.value = "";
    videoMetrics.value = null;

    if (videoPollTimer.value) {
      clearInterval(videoPollTimer.value);
    }

    videoPollTimer.value = setInterval(fetchVideoFrame, 260);
    await fetchVideoFrame();
  } catch (error) {
    alert(`视频实时识别失败: ${error.message}`);
  } finally {
    videoLoading.value = false;
  }
}

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
      await stopVideoInference(true);
      return;
    }

    console.error(error);
  } finally {
    videoPollingBusy.value = false;
  }
}

async function stopVideoInference(silent = false) {
  if (videoPollTimer.value) {
    clearInterval(videoPollTimer.value);
    videoPollTimer.value = null;
  }

  try {
    await api.post("/inference/video/stop");
  } catch (error) {
    if (!silent) {
      console.error(error);
    }
  }

  videoRunning.value = false;
}

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
    console.error(error);
  } finally {
    pollBusy.value = false;
  }
}

async function startCamera() {
  cameraLoading.value = true;
  try {
    await api.post("/inference/camera/start", {
      source: 0,
      model_name: selectedModel.value,
      conf: conf.value,
      device: selectedDevice.value,
    });

    cameraRunning.value = true;
    cameraFrame.value = "";
    cameraMetrics.value = null;

    if (pollTimer.value) {
      clearInterval(pollTimer.value);
    }

    pollTimer.value = setInterval(fetchCameraFrame, 260);
  } catch (error) {
    alert(`启动实时识别失败: ${error.message}`);
  } finally {
    cameraLoading.value = false;
  }
}

async function stopCamera() {
  if (pollTimer.value) {
    clearInterval(pollTimer.value);
    pollTimer.value = null;
  }

  try {
    await api.post("/inference/camera/stop");
  } catch (error) {
    console.error(error);
  }

  cameraRunning.value = false;
}

watch(
  [selectedModel, selectedDevice, conf],
  () => {
    persistHomeInferenceCache();
  },
  { deep: true },
);

onMounted(async () => {
  const cached = readHomeInferenceCache();
  applyHomeInferenceCache(cached);
  await loadSystemInfo();
});

onUnmounted(async () => {
  persistHomeInferenceCache();
  await Promise.allSettled([stopVideoInference(true), stopCamera()]);
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
          <option :value="deviceInfo?.selected_device || 'cpu'">
            自动优先设备
          </option>
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
                前车距离: {{ imageResult?.metrics?.distance_m ?? "--" }} m
              </div>
              <div class="metric-chip">
                推理耗时: {{ imageResult?.metrics?.inference_ms ?? "--" }} ms
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
