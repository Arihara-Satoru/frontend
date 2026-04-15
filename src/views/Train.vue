<script setup>
import { onMounted, onUnmounted, reactive, ref, watch } from "vue";

import api from "../utils/http";

const form = reactive({
  data: "",
  model: "ultralytics/cfg/models/v8/yolov8s_CA.yaml",
  weights: "yolov8s.pt",
  imgsz: 512,
  epochs: 150,
  batch: 16,
  device: "0",
  project: "runs/vehicle_ca",
  name: "yolov8s_ca_inneriou",
  cache: "disk",
  workers: 2,
  inner_iou_ratio: 0.7,
});

const TRAIN_FORM_STORAGE_KEY = "train_form_state_v1";
const TRAIN_NUMERIC_FIELDS = [
  "imgsz",
  "epochs",
  "batch",
  "workers",
  "inner_iou_ratio",
];

function readTrainFormCache() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(TRAIN_FORM_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("读取训练参数缓存失败", error);
    return null;
  }
}

function writeTrainFormCache(payload) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      TRAIN_FORM_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch (error) {
    console.warn("写入训练参数缓存失败", error);
  }
}

function applyCachedTrainForm() {
  const cached = readTrainFormCache();
  if (!cached) {
    return;
  }

  for (const [key, value] of Object.entries(cached)) {
    if (!(key in form) || value === null || value === undefined) {
      continue;
    }

    if (TRAIN_NUMERIC_FIELDS.includes(key)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        form[key] = numeric;
      }
      continue;
    }

    form[key] = String(value);
  }
}

function persistTrainForm() {
  writeTrainFormCache({
    ...form,
    savedAt: Date.now(),
  });
}

const paramTips = {
  data: "训练数据集配置文件路径（YAML），需包含 train/val 路径和类别信息。",
  model: "模型结构配置或模型定义路径，例如 YOLOv8 结构配置文件。",
  weights: "预训练权重文件路径；为空表示从头开始训练。",
  device: "训练设备。GPU 使用编号（如 0、1），CPU 使用 cpu。",
  imgsz: "训练输入分辨率，通常为 32 的倍数，越大精度潜力越高但显存占用越大。",
  epochs: "训练总轮次，轮次越多训练越充分，但耗时更长。",
  batch: "每次迭代的样本数，受显存限制；过大可能导致显存不足。",
  workers: "数据加载线程数，适当增大可提升数据读取速度。",
  inner_iou_ratio: "Inner-IoU 比例系数，用于你当前自定义损失设定。",
  cache: "数据缓存策略：disk(磁盘缓存)、ram(内存缓存)、none(不缓存)。",
  project: "训练输出主目录，包含日志、权重和可视化结果。",
  name: "本次训练实验名称，将作为 project 下的子目录。",
};

const running = ref(false);
const status = ref("idle");
const startedAt = ref("");
const endedAt = ref("");
const returnCode = ref(null);
const command = ref([]);
const logLines = ref([]);

const startLoading = ref(false);
const stopLoading = ref(false);
const trainingDevices = ref([]);
const loadingTrainingDevices = ref(false);

let pollTimer = null;

async function loadDefaults() {
  try {
    const response = await api.get("/train/defaults");
    Object.assign(form, response.data.data);
  } catch (error) {
    alert(`加载训练默认参数失败: ${error.message}`);
  }
}

async function loadTrainingDevices() {
  loadingTrainingDevices.value = true;
  try {
    const response = await api.get("/train/devices");
    trainingDevices.value = response.data.data || [];

    if (trainingDevices.value.length > 0) {
      const currentValue = String(form.device);
      const exists = trainingDevices.value.some(
        (item) => String(item.value) === currentValue,
      );
      if (!exists) {
        form.device = String(trainingDevices.value[0].value);
      }
    }
  } catch (error) {
    console.error(error);
    const currentValue = String(form.device || "cpu");
    trainingDevices.value = [
      { value: currentValue, label: `当前设备 (${currentValue})` },
      { value: "cpu", label: "CPU" },
    ].filter(
      (item, index, arr) =>
        arr.findIndex((x) => String(x.value) === String(item.value)) === index,
    );
  } finally {
    loadingTrainingDevices.value = false;
  }
}

async function refreshStatus() {
  try {
    const response = await api.get("/train/status");
    const data = response.data.data;

    running.value = data.running;
    status.value = data.status;
    startedAt.value = data.started_at || "";
    endedAt.value = data.ended_at || "";
    returnCode.value = data.return_code;
    command.value = data.command || [];
    logLines.value = data.log_tail || [];
  } catch (error) {
    console.error(error);
  }
}

async function startTraining() {
  if (!form.data) {
    alert("请填写数据集 YAML 路径 (data)");
    return;
  }

  startLoading.value = true;
  try {
    await api.post("/train/start", { ...form });
    await refreshStatus();
  } catch (error) {
    alert(`启动训练失败: ${error.message}`);
  } finally {
    startLoading.value = false;
  }
}

async function stopTraining() {
  stopLoading.value = true;
  try {
    await api.post("/train/stop");
    await refreshStatus();
  } catch (error) {
    alert(`停止训练失败: ${error.message}`);
  } finally {
    stopLoading.value = false;
  }
}

watch(
  form,
  () => {
    persistTrainForm();
  },
  { deep: true },
);

onMounted(async () => {
  await loadDefaults();
  applyCachedTrainForm();
  await loadTrainingDevices();
  await refreshStatus();
  pollTimer = setInterval(refreshStatus, 2000);
});

onUnmounted(() => {
  persistTrainForm();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<template>
  <section class="card-panel p-5">
    <h2 class="section-title">训练控制台</h2>
    <p class="section-subtitle mt-1">
      调用 ultralytics-8.4.35/train.py，支持自定义训练参数并实时查看日志
    </p>

    <div
      class="mt-4 grid gap-3 rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4 md:grid-cols-3"
    >
      <div class="md:col-span-3">
        <label class="field-label" :title="paramTips.data"
          >data (必填，数据集 YAML)</label
        >
        <input
          v-model="form.data"
          class="field-input"
          placeholder="例如: datasets/kitti_vehicle.yaml"
        />
      </div>

      <div>
        <label class="field-label" :title="paramTips.model">model</label>
        <input v-model="form.model" class="field-input" />
      </div>
      <div>
        <label class="field-label" :title="paramTips.weights">weights</label>
        <input v-model="form.weights" class="field-input" />
      </div>
      <div>
        <label class="field-label" :title="paramTips.device">device</label>
        <select
          v-model="form.device"
          class="field-input"
          :disabled="loadingTrainingDevices"
        >
          <option
            v-for="item in trainingDevices"
            :key="item.value"
            :value="String(item.value)"
          >
            {{ item.label }}
          </option>
        </select>
      </div>

      <div>
        <label class="field-label" :title="paramTips.imgsz">imgsz</label>
        <input v-model.number="form.imgsz" type="number" class="field-input" />
      </div>
      <div>
        <label class="field-label" :title="paramTips.epochs">epochs</label>
        <input v-model.number="form.epochs" type="number" class="field-input" />
      </div>
      <div>
        <label class="field-label" :title="paramTips.batch">batch</label>
        <input v-model.number="form.batch" type="number" class="field-input" />
      </div>

      <div>
        <label class="field-label" :title="paramTips.workers">workers</label>
        <input
          v-model.number="form.workers"
          type="number"
          class="field-input"
        />
      </div>
      <div>
        <label class="field-label" :title="paramTips.inner_iou_ratio"
          >inner_iou_ratio</label
        >
        <input
          v-model.number="form.inner_iou_ratio"
          type="number"
          step="0.01"
          class="field-input"
        />
      </div>
      <div>
        <label class="field-label" :title="paramTips.cache">cache</label>
        <select v-model="form.cache" class="field-input">
          <option value="disk">disk</option>
          <option value="ram">ram</option>
          <option value="none">none</option>
        </select>
      </div>

      <div>
        <label class="field-label" :title="paramTips.project">project</label>
        <input v-model="form.project" class="field-input" />
      </div>
      <div>
        <label class="field-label" :title="paramTips.name">name</label>
        <input v-model="form.name" class="field-input" />
      </div>
      <div class="flex items-end gap-2">
        <button
          class="btn-primary w-full"
          :disabled="startLoading || running"
          @click="startTraining"
        >
          {{ startLoading ? "启动中..." : running ? "训练进行中" : "启动训练" }}
        </button>
        <button
          class="btn-secondary w-full"
          :disabled="stopLoading || !running"
          @click="stopTraining"
        >
          {{ stopLoading ? "停止中..." : "停止训练" }}
        </button>
      </div>
    </div>
  </section>

  <section class="card-panel p-5">
    <h3 class="section-title">任务状态</h3>
    <div class="mt-3 grid gap-2 md:grid-cols-3">
      <div class="metric-chip">状态: {{ status }}</div>
      <div class="metric-chip">开始时间: {{ startedAt || "--" }}</div>
      <div class="metric-chip">结束时间: {{ endedAt || "--" }}</div>
      <div class="metric-chip">返回码: {{ returnCode ?? "--" }}</div>
      <div class="metric-chip md:col-span-2">
        运行命令: {{ command.join(" ") || "--" }}
      </div>
    </div>
  </section>

  <section class="card-panel p-5">
    <h3 class="section-title">训练日志（实时尾部）</h3>
    <div
      class="mt-3 max-h-[360px] overflow-auto rounded-xl border border-[var(--line-soft)] bg-[#0f1614] p-3"
    >
      <pre
        class="m-0 whitespace-pre-wrap break-all text-xs leading-6 text-[#d6f8ea]"
        >{{ logLines.join("\n") || "暂无日志输出" }}</pre
      >
    </div>
  </section>
</template>
