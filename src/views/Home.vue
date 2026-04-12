<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";

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
const videoResult = ref(null);
const videoLoading = ref(false);

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

const deviceText = computed(() => {
  if (!deviceInfo.value) return "未知设备";
  if (deviceInfo.value.selected_device?.startsWith("cuda")) {
    return `GPU (${deviceInfo.value.gpu_name || "CUDA"})`;
  }
  return "CPU";
});

async function loadSystemInfo() {
  loadingSystem.value = true;
  try {
    const [deviceRes, modelsRes] = await Promise.all([
      api.get("/system/device"),
      api.get("/system/models"),
    ]);

    deviceInfo.value = deviceRes.data.data;
    modelList.value = modelsRes.data.data;

    selectedDevice.value = deviceInfo.value?.selected_device || "cpu";
    if (
      availableModels.value.length > 0 &&
      !availableModels.value.some((m) => m.id === selectedModel.value)
    ) {
      selectedModel.value = availableModels.value[0].id;
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
  videoResult.value = null;
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

    const response = await api.post("/inference/video", form);
    videoResult.value = response.data.data;
  } catch (error) {
    alert(`视频识别失败: ${error.message}`);
  } finally {
    videoLoading.value = false;
  }
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

onMounted(loadSystemInfo);
onUnmounted(stopCamera);
</script>

<template>
  <div class="card-panel p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="section-title">识别中心</h2>
        <p class="section-subtitle">
          调用本地 YOLO 模型执行图片、视频和实时识别
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

  <div class="grid gap-5 xl:grid-cols-2">
    <section class="card-panel p-5">
      <h3 class="section-title">图片识别</h3>
      <p class="section-subtitle mt-1">
        框选高置信度车辆，并输出前车距离/速度/TTC
      </p>

      <div class="mt-4 space-y-3">
        <input
          type="file"
          accept="image/*"
          @change="onImageFileChange"
          class="field-input"
        />
        <button
          class="btn-primary"
          @click="runImageInference"
          :disabled="imageLoading"
        >
          {{ imageLoading ? "识别中..." : "开始图片识别" }}
        </button>
      </div>

      <div v-if="imageResult" class="mt-4 space-y-3">
        <img
          :src="imageResult.image"
          alt="image-result"
          class="w-full rounded-xl border border-[var(--line-soft)]"
        />
        <div class="flex flex-wrap gap-2">
          <div class="metric-chip">
            车辆数: {{ imageResult.metrics.vehicle_count }}
          </div>
          <div class="metric-chip">
            前车距离: {{ imageResult.metrics.distance_m ?? "--" }} m
          </div>
          <div class="metric-chip">
            相对速度: {{ imageResult.metrics.relative_speed_mps ?? "--" }} m/s
          </div>
          <div class="metric-chip">
            碰撞时间: {{ imageResult.metrics.ttc_seconds ?? "--" }} s
          </div>
          <div class="metric-chip">
            推理耗时: {{ imageResult.metrics.inference_ms }} ms
          </div>
          <div v-if="imageResult.metrics.alarm" class="alarm-chip">
            TTC 小于 3 秒，触发报警
          </div>
        </div>
      </div>
    </section>

    <section class="card-panel p-5">
      <h3 class="section-title">视频识别</h3>
      <p class="section-subtitle mt-1">
        输出带标注视频，前车单独颜色框，统计报警帧
      </p>

      <div class="mt-4 space-y-3">
        <input
          type="file"
          accept="video/*"
          @change="onVideoFileChange"
          class="field-input"
        />
        <button
          class="btn-primary"
          @click="runVideoInference"
          :disabled="videoLoading"
        >
          {{ videoLoading ? "处理中..." : "开始视频识别" }}
        </button>
      </div>

      <div v-if="videoResult" class="mt-4 space-y-3">
        <video
          :src="videoResult.video_url"
          controls
          class="w-full rounded-xl border border-[var(--line-soft)]"
        />
        <div class="flex flex-wrap gap-2">
          <div class="metric-chip">
            总帧数: {{ videoResult.summary.frame_count }}
          </div>
          <div class="metric-chip">
            报警帧数: {{ videoResult.summary.alarm_frames }}
          </div>
          <div class="metric-chip">
            平均置信度: {{ videoResult.summary.avg_confidence }}
          </div>
          <div class="metric-chip">
            平均推理耗时: {{ videoResult.summary.avg_inference_ms }} ms
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
