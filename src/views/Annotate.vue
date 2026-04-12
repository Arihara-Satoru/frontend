<script setup>
import { computed, nextTick, onMounted, ref } from "vue";

import api from "../utils/http";

const videoFile = ref(null);
const modelFile = ref(null);

const classText = ref("car,bus,truck");
const frameStep = ref(5);
const maxFrames = ref(200);
const trainRatio = ref(0.8);
const datasetName = ref("");

const sessionId = ref("");
const classList = ref([]);
const selectedClassId = ref(0);

const frames = ref([]);
const currentFrameIndex = ref(0);
const currentBoxes = ref([]);
const unsaved = ref(false);

const annotateCanvas = ref(null);
const imageElement = ref(null);
let drawing = false;
let drawStart = { x: 0, y: 0 };
let draftBox = null;

const loadingUpload = ref(false);
const loadingExtract = ref(false);
const loadingSaveBox = ref(false);
const loadingAutoLabel = ref(false);
const loadingSplit = ref(false);

const modelOptions = ref([]);
const selectedModel = ref("yolov8n");
const autoLabelConf = ref(0.25);
const autoLabelDevice = ref("cpu");

const splitResult = ref(null);
const autoLabelResult = ref(null);

const currentFrame = computed(
  () => frames.value[currentFrameIndex.value] || null,
);

function parseClassText(text) {
  const raw = text
    .split(/[,\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(raw)];
}

function onVideoFileChange(event) {
  videoFile.value = event.target.files?.[0] || null;
}

function onModelFileChange(event) {
  modelFile.value = event.target.files?.[0] || null;
}

function colorForClass(classId) {
  const palette = [
    "#ef4444",
    "#0ea5e9",
    "#10b981",
    "#f59e0b",
    "#8b5cf6",
    "#f97316",
    "#14b8a6",
    "#e11d48",
  ];
  return palette[classId % palette.length];
}

function refreshCanvas() {
  const canvas = annotateCanvas.value;
  const image = imageElement.value;
  if (!canvas || !image) return;

  const ctx = canvas.getContext("2d");
  canvas.width = image.width;
  canvas.height = image.height;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const box of currentBoxes.value) {
    const color = colorForClass(Number(box.class_id || 0));
    const x = Math.min(box.x1, box.x2);
    const y = Math.min(box.y1, box.y2);
    const w = Math.abs(box.x2 - box.x1);
    const h = Math.abs(box.y2 - box.y1);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    const className =
      classList.value[Number(box.class_id)] || box.class_name || "class";
    const text = `${className}`;
    ctx.font = "16px Microsoft YaHei";
    const textWidth = ctx.measureText(text).width;

    ctx.fillStyle = color;
    ctx.fillRect(x, Math.max(0, y - 22), textWidth + 12, 22);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + 6, Math.max(16, y - 6));
  }

  if (draftBox) {
    const x = Math.min(draftBox.x1, draftBox.x2);
    const y = Math.min(draftBox.y1, draftBox.y2);
    const w = Math.abs(draftBox.x2 - draftBox.x1);
    const h = Math.abs(draftBox.y2 - draftBox.y1);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#0b9a72";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
}

function toCanvasPoint(event) {
  const canvas = annotateCanvas.value;
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
  const y = ((event.clientY - rect.top) * canvas.height) / rect.height;
  return {
    x: Math.max(0, Math.min(canvas.width, x)),
    y: Math.max(0, Math.min(canvas.height, y)),
  };
}

function onCanvasMouseDown(event) {
  if (!currentFrame.value) return;
  drawing = true;
  const pt = toCanvasPoint(event);
  drawStart = { ...pt };
  draftBox = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
  refreshCanvas();
}

function onCanvasMouseMove(event) {
  if (!drawing || !draftBox) return;
  const pt = toCanvasPoint(event);
  draftBox.x2 = pt.x;
  draftBox.y2 = pt.y;
  refreshCanvas();
}

function onCanvasMouseUp(event) {
  if (!drawing || !draftBox) return;
  drawing = false;

  const pt = toCanvasPoint(event);
  draftBox.x2 = pt.x;
  draftBox.y2 = pt.y;

  const width = Math.abs(draftBox.x2 - draftBox.x1);
  const height = Math.abs(draftBox.y2 - draftBox.y1);

  if (width >= 6 && height >= 6) {
    const classId = Number(selectedClassId.value || 0);
    currentBoxes.value.push({
      class_id: classId,
      class_name: classList.value[classId] || `class_${classId}`,
      x1: Math.min(draftBox.x1, draftBox.x2),
      y1: Math.min(draftBox.y1, draftBox.y2),
      x2: Math.max(draftBox.x1, draftBox.x2),
      y2: Math.max(draftBox.y1, draftBox.y2),
    });
    unsaved.value = true;
  }

  draftBox = null;
  refreshCanvas();
}

function onCanvasMouseLeave() {
  if (drawing) {
    drawing = false;
    draftBox = null;
    refreshCanvas();
  }
}

function clearBoxes() {
  currentBoxes.value = [];
  unsaved.value = true;
  refreshCanvas();
}

function undoBox() {
  currentBoxes.value.pop();
  unsaved.value = true;
  refreshCanvas();
}

async function loadModels() {
  try {
    const response = await api.get("/annotate/models");
    modelOptions.value = response.data.data || [];
    if (modelOptions.value.length > 0) {
      selectedModel.value = modelOptions.value[0].id;
    }
  } catch (error) {
    console.error(error);
  }
}

async function uploadModel() {
  if (!modelFile.value) {
    alert("请先选择要上传的模型文件（.pt）");
    return;
  }

  try {
    const formData = new FormData();
    formData.append("file", modelFile.value);
    const response = await api.post("/annotate/models/upload", formData);
    await loadModels();
    selectedModel.value = response.data.data.model_name;
    alert("模型上传成功，已加入自动标注列表");
  } catch (error) {
    alert(`上传模型失败: ${error.message}`);
  }
}

async function createSessionAndExtract() {
  if (!videoFile.value) {
    alert("请先上传视频文件");
    return;
  }

  const parsedClasses = parseClassText(classText.value);
  if (parsedClasses.length === 0) {
    alert("请至少填写一个类别");
    return;
  }

  loadingUpload.value = true;
  splitResult.value = null;
  autoLabelResult.value = null;

  try {
    const createForm = new FormData();
    createForm.append("file", videoFile.value);
    createForm.append("classes", parsedClasses.join(","));

    const createRes = await api.post("/annotate/session/create", createForm);
    sessionId.value = createRes.data.data.session_id;
    classList.value = createRes.data.data.classes || parsedClasses;
    selectedClassId.value = 0;
  } catch (error) {
    alert(`创建会话失败: ${error.message}`);
    loadingUpload.value = false;
    return;
  }

  loadingUpload.value = false;
  loadingExtract.value = true;

  try {
    const extractRes = await api.post("/annotate/session/extract", {
      session_id: sessionId.value,
      frame_step: Number(frameStep.value),
      max_frames: Number(maxFrames.value),
      start_frame: 0,
    });

    frames.value = extractRes.data.data.frames || [];
    classList.value = extractRes.data.data.classes || classList.value;
    selectedClassId.value = 0;
    currentFrameIndex.value = 0;

    if (frames.value.length > 0) {
      await loadCurrentFrame();
    }
  } catch (error) {
    alert(`切帧失败: ${error.message}`);
  } finally {
    loadingExtract.value = false;
  }
}

async function loadFrameAnnotation(frameName) {
  const response = await api.get(
    `/annotate/session/${sessionId.value}/annotation/${frameName}`,
  );
  classList.value = response.data.data.classes || classList.value;
  currentBoxes.value = response.data.data.boxes || [];
  selectedClassId.value = Math.min(
    Number(selectedClassId.value || 0),
    Math.max(0, classList.value.length - 1),
  );
}

async function loadCurrentFrame() {
  if (!currentFrame.value || !sessionId.value) return;

  await loadFrameAnnotation(currentFrame.value.frame_name);

  const image = new Image();
  image.onload = async () => {
    imageElement.value = image;
    await nextTick();
    refreshCanvas();
  };
  image.src = `${currentFrame.value.image_url}?t=${Date.now()}`;
  unsaved.value = false;
}

async function switchFrame(index) {
  if (index < 0 || index >= frames.value.length) return;

  if (unsaved.value) {
    const ok = window.confirm("当前帧有未保存标注，确定切换帧吗？");
    if (!ok) return;
  }

  currentFrameIndex.value = index;
  await loadCurrentFrame();
}

async function saveCurrentFrameAnnotation() {
  if (!sessionId.value || !currentFrame.value) return;

  loadingSaveBox.value = true;
  try {
    const payload = {
      boxes: currentBoxes.value,
    };

    const response = await api.post(
      `/annotate/session/${sessionId.value}/annotation/${currentFrame.value.frame_name}`,
      payload,
    );

    const classes = response.data.data.classes || [];
    if (classes.length > 0) {
      classList.value = classes;
    }

    frames.value[currentFrameIndex.value].has_label =
      Number(response.data.data.saved_boxes || 0) > 0;
    unsaved.value = false;
    alert("当前帧标注已保存");
  } catch (error) {
    alert(`保存失败: ${error.message}`);
  } finally {
    loadingSaveBox.value = false;
  }
}

async function saveClassList() {
  if (!sessionId.value) {
    alert("请先上传视频并切帧");
    return;
  }

  const classes = parseClassText(classText.value);
  if (classes.length === 0) {
    alert("类别不能为空");
    return;
  }

  try {
    const response = await api.post(
      `/annotate/session/${sessionId.value}/classes`,
      {
        classes,
      },
    );
    classList.value = response.data.data.classes;
    selectedClassId.value = Math.min(
      Number(selectedClassId.value || 0),
      Math.max(0, classList.value.length - 1),
    );
    refreshCanvas();
    alert("类别已更新");
  } catch (error) {
    alert(`更新类别失败: ${error.message}`);
  }
}

async function runAutoLabel() {
  if (!sessionId.value) {
    alert("请先完成视频上传与切帧");
    return;
  }

  if (!selectedModel.value) {
    alert("请先选择用于自动标注的模型");
    return;
  }

  loadingAutoLabel.value = true;
  try {
    const response = await api.post(
      `/annotate/session/${sessionId.value}/auto-label`,
      {
        model_name: selectedModel.value,
        conf: Number(autoLabelConf.value),
        device: autoLabelDevice.value,
      },
    );

    autoLabelResult.value = response.data.data;
    classList.value = response.data.data.classes || classList.value;

    const refreshRes = await api.get(
      `/annotate/session/${sessionId.value}/frames`,
    );
    frames.value = refreshRes.data.data.frames || frames.value;
    if (currentFrame.value) {
      await loadCurrentFrame();
    }
  } catch (error) {
    alert(`自动标注失败: ${error.message}`);
  } finally {
    loadingAutoLabel.value = false;
  }
}

async function splitDataset() {
  if (!sessionId.value) {
    alert("请先完成标注会话");
    return;
  }

  loadingSplit.value = true;
  try {
    const response = await api.post(
      `/annotate/session/${sessionId.value}/split`,
      {
        dataset_name: datasetName.value,
        train_ratio: Number(trainRatio.value),
        seed: 42,
      },
    );

    splitResult.value = response.data.data;
  } catch (error) {
    alert(`划分失败: ${error.message}`);
  } finally {
    loadingSplit.value = false;
  }
}

onMounted(async () => {
  await loadModels();
});
</script>

<template>
  <section class="card-panel p-5">
    <h2 class="section-title">数据标注与数据集构建</h2>
    <p class="section-subtitle mt-1">
      支持视频切帧、手工框选标注、上传模型自动标注，并一键划分训练集/验证集。
    </p>

    <div
      class="mt-4 grid gap-3 rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4 md:grid-cols-4"
    >
      <div class="md:col-span-2">
        <label class="field-label">上传视频</label>
        <input
          class="field-input"
          type="file"
          accept="video/*"
          @change="onVideoFileChange"
        />
      </div>

      <div>
        <label class="field-label">按帧间隔切割（frame_step）</label>
        <input
          v-model.number="frameStep"
          class="field-input"
          type="number"
          min="1"
        />
      </div>

      <div>
        <label class="field-label">最多提取帧数</label>
        <input
          v-model.number="maxFrames"
          class="field-input"
          type="number"
          min="10"
          max="5000"
        />
      </div>

      <div class="md:col-span-3">
        <label class="field-label">类别列表（逗号或换行分隔）</label>
        <textarea
          v-model="classText"
          rows="2"
          class="field-input"
          placeholder="例如: car,bus,truck"
        />
      </div>

      <div class="flex items-end">
        <button
          class="btn-primary w-full"
          :disabled="loadingUpload || loadingExtract"
          @click="createSessionAndExtract"
        >
          {{ loadingUpload || loadingExtract ? "处理中..." : "上传并切帧" }}
        </button>
      </div>
    </div>

    <div class="mt-3 flex flex-wrap gap-2 text-xs text-[var(--ink-sub)]">
      <span class="metric-chip">会话ID: {{ sessionId || "未创建" }}</span>
      <span class="metric-chip">总帧数: {{ frames.length }}</span>
      <span class="metric-chip">类别数: {{ classList.length }}</span>
    </div>
  </section>

  <section class="grid gap-5 xl:grid-cols-[300px_1fr]">
    <aside class="card-panel p-4">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="section-title">帧列表</h3>
        <button class="btn-secondary px-3 py-1" @click="saveClassList">
          更新类别
        </button>
      </div>
      <div class="max-h-[620px] space-y-2 overflow-auto">
        <button
          v-for="(frame, index) in frames"
          :key="frame.frame_name"
          class="w-full rounded-xl border p-2 text-left transition"
          :class="[
            index === currentFrameIndex
              ? 'border-[var(--brand)] bg-emerald-50'
              : 'border-[var(--line-soft)] bg-white',
          ]"
          @click="switchFrame(index)"
        >
          <img
            :src="`${frame.image_url}?thumb=1`"
            class="h-24 w-full rounded-lg object-cover"
          />
          <div class="mt-1 text-xs font-semibold">{{ frame.frame_name }}</div>
          <div class="mt-1 text-[11px] text-[var(--ink-sub)]">
            {{ frame.width }} x {{ frame.height }}
            <span
              class="ml-2"
              :class="frame.has_label ? 'text-emerald-600' : 'text-slate-500'"
            >
              {{ frame.has_label ? "已标注" : "未标注" }}
            </span>
          </div>
        </button>
      </div>
    </aside>

    <div class="space-y-5">
      <section class="card-panel p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="section-title">手工标注</h3>
          <div class="flex flex-wrap items-center gap-2">
            <label class="field-label mb-0">当前类别</label>
            <select
              v-model.number="selectedClassId"
              class="field-input min-w-[160px]"
            >
              <option
                v-for="(name, index) in classList"
                :key="`${name}-${index}`"
                :value="index"
              >
                {{ index }} - {{ name }}
              </option>
            </select>
            <button class="btn-secondary" @click="undoBox">撤销</button>
            <button class="btn-secondary" @click="clearBoxes">清空</button>
            <button
              class="btn-primary"
              :disabled="loadingSaveBox || !currentFrame"
              @click="saveCurrentFrameAnnotation"
            >
              {{ loadingSaveBox ? "保存中..." : "保存当前帧标注" }}
            </button>
          </div>
        </div>

        <p class="mt-2 text-xs text-[var(--ink-sub)]">
          鼠标左键拖动绘制框；切换帧前建议先保存。当前框数：{{
            currentBoxes.length
          }}。
        </p>

        <div
          class="mt-3 overflow-auto rounded-xl border border-[var(--line-soft)] bg-[#0f172a] p-2"
        >
          <canvas
            ref="annotateCanvas"
            class="mx-auto max-h-[620px] max-w-full cursor-crosshair rounded-lg bg-black"
            @mousedown="onCanvasMouseDown"
            @mousemove="onCanvasMouseMove"
            @mouseup="onCanvasMouseUp"
            @mouseleave="onCanvasMouseLeave"
          />
        </div>
      </section>

      <section class="grid gap-4 lg:grid-cols-2">
        <div class="card-panel p-4">
          <h3 class="section-title">模型自动标注</h3>
          <p class="section-subtitle mt-1">
            可直接选系统模型，或上传你自己的 .pt 模型。
          </p>

          <div class="mt-3 space-y-3">
            <div>
              <label class="field-label">选择模型</label>
              <select v-model="selectedModel" class="field-input">
                <option
                  v-for="item in modelOptions"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.display_name }}
                </option>
              </select>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <label class="field-label"
                  >置信度: {{ autoLabelConf.toFixed(2) }}</label
                >
                <input
                  v-model.number="autoLabelConf"
                  type="range"
                  min="0.05"
                  max="0.95"
                  step="0.01"
                  class="w-full"
                />
              </div>

              <div>
                <label class="field-label">device</label>
                <select v-model="autoLabelDevice" class="field-input">
                  <option value="cpu">cpu</option>
                  <option value="cuda:0">cuda:0</option>
                </select>
              </div>
            </div>

            <div class="grid gap-2 md:grid-cols-2">
              <input
                class="field-input"
                type="file"
                accept=".pt"
                @change="onModelFileChange"
              />
              <button class="btn-secondary" @click="uploadModel">
                上传模型
              </button>
            </div>

            <button
              class="btn-primary w-full"
              :disabled="loadingAutoLabel || !sessionId"
              @click="runAutoLabel"
            >
              {{ loadingAutoLabel ? "自动标注中..." : "一键自动标注当前会话" }}
            </button>
          </div>

          <div v-if="autoLabelResult" class="mt-3 flex flex-wrap gap-2">
            <span class="metric-chip"
              >标注帧数: {{ autoLabelResult.labeled_frames }}</span
            >
            <span class="metric-chip"
              >标注框总数: {{ autoLabelResult.total_boxes }}</span
            >
            <span class="metric-chip"
              >模型: {{ autoLabelResult.model_path }}</span
            >
          </div>
        </div>

        <div class="card-panel p-4">
          <h3 class="section-title">一键划分训练集/测试集</h3>
          <p class="section-subtitle mt-1">
            自动复制图像与标注文件，生成可直接训练的 dataset.yaml。
          </p>

          <div class="mt-3 space-y-3">
            <div>
              <label class="field-label">数据集名称</label>
              <input
                v-model="datasetName"
                class="field-input"
                placeholder="例如: vehicle_dataset_v1（留空自动生成）"
              />
            </div>

            <div>
              <label class="field-label"
                >训练集比例: {{ trainRatio.toFixed(2) }}</label
              >
              <input
                v-model.number="trainRatio"
                type="range"
                min="0.5"
                max="0.95"
                step="0.01"
                class="w-full"
              />
            </div>

            <button
              class="btn-primary w-full"
              :disabled="loadingSplit || !sessionId"
              @click="splitDataset"
            >
              {{ loadingSplit ? "划分中..." : "一键划分并生成 dataset.yaml" }}
            </button>
          </div>

          <div v-if="splitResult" class="mt-3 space-y-2 text-xs">
            <div class="metric-chip">
              数据集目录: {{ splitResult.dataset_dir }}
            </div>
            <div class="metric-chip">
              YAML: {{ splitResult.dataset_yaml_path }}
            </div>
            <div class="metric-chip">
              训练集: {{ splitResult.train_count }} (已标注
              {{ splitResult.train_labeled }})
            </div>
            <div class="metric-chip">
              测试集:
              {{ splitResult.test_count ?? splitResult.val_count }} (已标注
              {{ splitResult.test_labeled ?? splitResult.val_labeled }})
            </div>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>
