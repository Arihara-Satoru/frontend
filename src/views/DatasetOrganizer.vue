<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import api from "../utils/http";

const DATASET_PAGE_STORAGE_KEY = "dataset_page_state_v1";
const DEFAULT_TRAFFIC_CLASSES = [
  "bicycle",
  "car",
  "motorcycle",
  "bus",
  "train",
  "truck",
  "traffic light",
  "stop sign",
  "parking meter",
].join(",");

const form = reactive({
  scanRoot: "dataset_download",
  sourcePath: "",
  targetRoot: "dataset",
  outputName: "",
  format: "auto",
  trainRatio: 0.8,
  seed: 42,
  includeEmptyLabels: true,
  overwrite: false,
  cocoAnnotationFiles: "",
  cocoImageRoot: "",
  classNames: "",
  trafficSourcePath: "dataset_download/coco",
  trafficTargetRoot: "dataset_download",
  trafficOutputName: "coco_traffic",
  trafficClasses: DEFAULT_TRAFFIC_CLASSES,
  trafficSplits: "train,val",
  trafficIncludeEmptyLabels: false,
  trafficCopyMode: "copy",
  trafficOverwrite: false,
});

const loadingDefaults = ref(false);
const loadingSources = ref(false);
const loadingConvert = ref(false);
const loadingTraffic = ref(false);
const loadingHistory = ref(false);

const sourceItems = ref([]);
const historyItems = ref([]);
const convertResult = ref(null);
const trafficResult = ref(null);

const supportedFormats = ref(["auto", "coco", "yolo", "voc"]);

const visibleSourceItems = computed(() =>
  sourceItems.value.filter((item) => item.detected_format !== "unknown"),
);

const detectedConvertibleCount = computed(
  () => visibleSourceItems.value.filter((item) => item.convertible).length,
);

// 数据集整理页用缓存保存目录和转换参数，便于反复调整时保留输入内容。
function readCache() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(DATASET_PAGE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("读取数据集整理页缓存失败", error);
    return null;
  }
}

// 写缓存只保存配置和最近结果，不保存临时扫描列表。
function writeCache(payload) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      DATASET_PAGE_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch (error) {
    console.warn("写入数据集整理页缓存失败", error);
  }
}

// 数值型参数统一做上下界处理，避免 seed 和比例出现非法值。
function toBoundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

// 恢复页面状态，避免刷新后丢失输入参数。
function applyCache(cached) {
  if (!cached || typeof cached !== "object") {
    return;
  }

  if (typeof cached.scanRoot === "string") {
    form.scanRoot = cached.scanRoot;
  }
  if (typeof cached.sourcePath === "string") {
    form.sourcePath = cached.sourcePath;
  }
  if (typeof cached.targetRoot === "string") {
    form.targetRoot = cached.targetRoot;
  }
  if (typeof cached.outputName === "string") {
    form.outputName = cached.outputName;
  }
  if (typeof cached.format === "string" && cached.format.trim()) {
    form.format = cached.format;
  }

  form.trainRatio = toBoundedNumber(
    cached.trainRatio,
    form.trainRatio,
    0.5,
    0.95,
  );
  form.seed = Math.max(
    0,
    Math.floor(toBoundedNumber(cached.seed, form.seed, 0, 999999)),
  );

  form.includeEmptyLabels = Boolean(cached.includeEmptyLabels);
  form.overwrite = Boolean(cached.overwrite);

  if (typeof cached.cocoAnnotationFiles === "string") {
    form.cocoAnnotationFiles = cached.cocoAnnotationFiles;
  }
  if (typeof cached.cocoImageRoot === "string") {
    form.cocoImageRoot = cached.cocoImageRoot;
  }
  if (typeof cached.classNames === "string") {
    form.classNames = cached.classNames;
  }

  if (typeof cached.trafficSourcePath === "string") {
    form.trafficSourcePath = cached.trafficSourcePath;
  }
  if (typeof cached.trafficTargetRoot === "string") {
    form.trafficTargetRoot = cached.trafficTargetRoot;
  }
  if (typeof cached.trafficOutputName === "string") {
    form.trafficOutputName = cached.trafficOutputName;
  }
  if (typeof cached.trafficClasses === "string") {
    form.trafficClasses = cached.trafficClasses;
  }
  if (typeof cached.trafficSplits === "string") {
    form.trafficSplits = cached.trafficSplits;
  }
  form.trafficIncludeEmptyLabels = Boolean(cached.trafficIncludeEmptyLabels);
  form.trafficOverwrite = Boolean(cached.trafficOverwrite);
  if (
    typeof cached.trafficCopyMode === "string" &&
    ["copy", "hardlink"].includes(cached.trafficCopyMode)
  ) {
    form.trafficCopyMode = cached.trafficCopyMode;
  }

  if (cached.convertResult && typeof cached.convertResult === "object") {
    convertResult.value = cached.convertResult;
  }
  if (cached.trafficResult && typeof cached.trafficResult === "object") {
    trafficResult.value = cached.trafficResult;
  }
}

// 页面任何输入变化都会同步到缓存，确保用户能继续上一次的整理配置。
function persistCache() {
  writeCache({
    ...form,
    convertResult: convertResult.value,
    trafficResult: trafficResult.value,
    savedAt: Date.now(),
  });
}

// 多行输入统一拆分成干净的字符串数组，适合文件列表、类别列表和 splits 配置。
function normalizeMultilineInput(rawText) {
  return String(rawText || "")
    .split(/[,\n\r;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 点击扫描结果时，自动把目录路径、格式和 COCO 标注文件带入下方表单。
function fillSource(item) {
  form.sourcePath = item.path || item.relative_path || "";
  if (item.detected_format && item.detected_format !== "unknown") {
    form.format = item.detected_format;
  }

  if (
    Array.isArray(item.coco_annotations) &&
    item.coco_annotations.length > 0
  ) {
    form.cocoAnnotationFiles = item.coco_annotations.join("\n");
  }
}

// 默认参数由后端返回，前端只在当前值还是初始默认时才用它覆盖。
async function loadDefaults() {
  loadingDefaults.value = true;
  try {
    const response = await api.get("/dataset/defaults");
    const data = response.data.data || {};

    if (typeof data.source_root === "string" && !form.scanRoot) {
      form.scanRoot = data.source_root;
    }
    if (typeof data.target_root === "string" && !form.targetRoot) {
      form.targetRoot = data.target_root;
    }

    if (
      Array.isArray(data.supported_formats) &&
      data.supported_formats.length > 0
    ) {
      supportedFormats.value = data.supported_formats;
    }

    if (
      typeof data.traffic_default_source === "string" &&
      form.trafficSourcePath === "dataset_download/coco"
    ) {
      form.trafficSourcePath = data.traffic_default_source;
    }
    if (
      typeof data.traffic_default_target_root === "string" &&
      form.trafficTargetRoot === "dataset_download"
    ) {
      form.trafficTargetRoot = data.traffic_default_target_root;
    }
    if (
      typeof data.traffic_default_output_name === "string" &&
      form.trafficOutputName === "coco_traffic"
    ) {
      form.trafficOutputName = data.traffic_default_output_name;
    }
    if (
      Array.isArray(data.traffic_default_classes) &&
      data.traffic_default_classes.length > 0 &&
      form.trafficClasses === DEFAULT_TRAFFIC_CLASSES
    ) {
      form.trafficClasses = data.traffic_default_classes.join(",");
    }
  } catch (error) {
    alert(`加载数据集整理默认参数失败: ${error.message}`);
  } finally {
    loadingDefaults.value = false;
  }
}

// 扫描源目录用于发现可转换的数据集结构，结果会直接显示在页面卡片里。
async function scanSources() {
  if (!form.scanRoot.trim()) {
    alert("请先填写扫描目录");
    return;
  }

  loadingSources.value = true;
  try {
    const response = await api.get("/dataset/sources", {
      params: { root: form.scanRoot.trim() },
    });
    sourceItems.value = response.data.data?.items || [];
  } catch (error) {
    alert(`扫描数据源失败: ${error.message}`);
  } finally {
    loadingSources.value = false;
  }
}

// 转换历史来自后端持久化记录，方便回看上一次整理过什么目录。
async function loadHistory() {
  loadingHistory.value = true;
  try {
    const response = await api.get("/dataset/history");
    historyItems.value = response.data.data || [];
  } catch (error) {
    alert(`读取转换历史失败: ${error.message}`);
  } finally {
    loadingHistory.value = false;
  }
}

// 清空历史只删除记录，不删除已生成的数据集文件。
async function clearHistory() {
  const ok = window.confirm(
    "确定清空转换历史吗？该操作只清空历史记录，不会删除已转换数据集。",
  );
  if (!ok) {
    return;
  }

  loadingHistory.value = true;
  try {
    await api.delete("/dataset/history");
    historyItems.value = [];
  } catch (error) {
    alert(`清空历史失败: ${error.message}`);
  } finally {
    loadingHistory.value = false;
  }
}

// 数据集转换请求会把所有目录与格式参数统一发给后端执行。
async function convertDataset() {
  if (!form.sourcePath.trim()) {
    alert("请先填写源数据集目录");
    return;
  }

  loadingConvert.value = true;
  try {
    const payload = {
      source_path: form.sourcePath.trim(),
      target_root: form.targetRoot.trim() || "dataset",
      output_name: form.outputName.trim(),
      format: form.format,
      train_ratio: Number(form.trainRatio),
      seed: Number(form.seed),
      include_empty_labels: form.includeEmptyLabels,
      overwrite: form.overwrite,
      coco_annotation_files: normalizeMultilineInput(form.cocoAnnotationFiles),
      coco_image_root: form.cocoImageRoot.trim(),
      class_names: normalizeMultilineInput(form.classNames),
    };

    const response = await api.post("/dataset/convert", payload);
    convertResult.value = response.data.data || null;

    if (convertResult.value?.history_record) {
      historyItems.value = [
        convertResult.value.history_record,
        ...historyItems.value.filter(
          (item) => item.id !== convertResult.value.history_record.id,
        ),
      ];
    }

    alert("数据集转换完成");
  } catch (error) {
    alert(`数据集转换失败: ${error.message}`);
  } finally {
    loadingConvert.value = false;
  }
}

// 交通子集提取是从既有 YOLO 数据中筛出车辆相关类别并重新组织目录结构。
async function extractTrafficSubset() {
  if (!form.trafficSourcePath.trim()) {
    alert("请先填写交通子集源目录");
    return;
  }

  loadingTraffic.value = true;
  try {
    const payload = {
      source_path: form.trafficSourcePath.trim(),
      target_root: form.trafficTargetRoot.trim() || "dataset_download",
      output_name: form.trafficOutputName.trim() || "coco_traffic",
      class_names: normalizeMultilineInput(form.trafficClasses),
      splits: normalizeMultilineInput(form.trafficSplits),
      include_empty_labels: form.trafficIncludeEmptyLabels,
      copy_mode: form.trafficCopyMode,
      overwrite: form.trafficOverwrite,
      seed: Number(form.seed),
      train_ratio: Number(form.trainRatio),
    };

    const response = await api.post("/dataset/traffic-subset", payload);
    trafficResult.value = response.data.data || null;
    alert("交通子集提取完成");
  } catch (error) {
    alert(`交通子集提取失败: ${error.message}`);
  } finally {
    loadingTraffic.value = false;
  }
}

// 表单和结果变更都会落到缓存里，刷新后依然保留最近一次整理配置。
watch(
  form,
  () => {
    persistCache();
  },
  { deep: true },
);

// 最近的转换结果也要保存，这样回来时不用重新扫目录。
watch(convertResult, () => {
  persistCache();
});

// 最近一次交通子集结果同样写回缓存，方便查看和继续操作。
watch(trafficResult, () => {
  persistCache();
});

// 挂载时按“恢复缓存 -> 加载默认参数 -> 历史记录”的顺序初始化。
onMounted(async () => {
  applyCache(readCache());
  await loadDefaults();
  // 扫描目录可能比较重，改为用户手动点击触发，避免页面首次打开就阻塞。
  await loadHistory();
});
</script>

<template>
  <section class="card-panel p-5">
    <h2 class="section-title">数据集整理与转换</h2>
    <p class="section-subtitle mt-1">
      面向 COCO / YOLO / VOC 的统一转换入口。默认读取根目录
      dataset_download，输出到根目录 dataset。
    </p>

    <div
      class="mt-4 grid gap-3 rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4 md:grid-cols-4"
    >
      <div class="md:col-span-2">
        <label class="field-label">扫描目录（可填其它下载路径）</label>
        <input
          v-model="form.scanRoot"
          class="field-input"
          placeholder="例如: dataset_download 或 D:/datasets"
        />
      </div>
      <div class="md:col-span-2 flex items-end gap-2">
        <button
          class="btn-secondary w-full"
          :disabled="loadingDefaults"
          @click="loadDefaults"
        >
          {{ loadingDefaults ? "加载中..." : "恢复默认目录" }}
        </button>
        <button
          class="btn-primary w-full"
          :disabled="loadingSources"
          @click="scanSources"
        >
          {{ loadingSources ? "扫描中..." : "扫描数据源" }}
        </button>
      </div>
      <div class="metric-chip md:col-span-4">
        已扫描 {{ visibleSourceItems.length }} 个目录，可转换
        {{ detectedConvertibleCount }} 个
      </div>
    </div>
  </section>

  <section class="card-panel p-5">
    <h3 class="section-title">扫描结果</h3>
    <p class="section-subtitle mt-1">
      点击“使用该目录”可快速带入源目录与格式。
    </p>

    <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <article
        v-for="item in visibleSourceItems"
        :key="item.path"
        class="rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="text-sm font-bold text-[var(--ink-main)]">
            {{ item.name }}
          </div>
          <span
            class="rounded-full border px-2 py-0.5 text-xs"
            :class="
              item.convertible
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-slate-200 bg-slate-50 text-slate-600'
            "
          >
            {{ item.detected_format }}
          </span>
        </div>
        <p class="mt-2 line-clamp-2 text-xs text-[var(--ink-sub)] break-all">
          {{ item.relative_path }}
        </p>

        <p class="mt-2 text-xs text-[var(--ink-sub)]">
          标注文件: {{ (item.coco_annotations || []).length }}
        </p>

        <button class="btn-secondary mt-3 w-full" @click="fillSource(item)">
          使用该目录
        </button>
      </article>
    </div>
  </section>

  <section class="card-panel p-5">
    <h3 class="section-title">转换参数</h3>
    <p class="section-subtitle mt-1">
      source_path
      支持填写绝对路径或相对路径（相对根目录）。如果是其它来源数据集，直接改成对应路径即可。
    </p>

    <div
      class="mt-4 grid gap-3 rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4 md:grid-cols-3"
    >
      <div class="md:col-span-2">
        <label class="field-label">source_path (源目录)</label>
        <input
          v-model="form.sourcePath"
          class="field-input"
          placeholder="例如: dataset_download/coco128 或 D:/datasets/coco"
        />
      </div>
      <div>
        <label class="field-label">format</label>
        <select v-model="form.format" class="field-input">
          <option v-for="item in supportedFormats" :key="item" :value="item">
            {{ item }}
          </option>
        </select>
      </div>

      <div>
        <label class="field-label">target_root (输出根目录)</label>
        <input
          v-model="form.targetRoot"
          class="field-input"
          placeholder="默认: dataset"
        />
      </div>
      <div>
        <label class="field-label">output_name (可选)</label>
        <input
          v-model="form.outputName"
          class="field-input"
          placeholder="为空时使用源目录名"
        />
      </div>
      <div>
        <label class="field-label">seed</label>
        <input
          v-model.number="form.seed"
          type="number"
          min="0"
          class="field-input"
        />
      </div>

      <div>
        <label class="field-label">train_ratio</label>
        <input
          v-model.number="form.trainRatio"
          type="number"
          min="0.5"
          max="0.95"
          step="0.01"
          class="field-input"
        />
      </div>
      <div
        class="rounded-xl border border-[var(--line-soft)] bg-white px-3 py-2 text-sm"
      >
        <label class="flex items-center gap-2">
          <input v-model="form.includeEmptyLabels" type="checkbox" />
          写入空标签文件
        </label>
      </div>
      <div
        class="rounded-xl border border-[var(--line-soft)] bg-white px-3 py-2 text-sm"
      >
        <label class="flex items-center gap-2">
          <input v-model="form.overwrite" type="checkbox" />
          覆盖同名输出目录
        </label>
      </div>

      <div class="md:col-span-3">
        <label class="field-label">class_names (可选，逗号或换行分隔)</label>
        <textarea
          v-model="form.classNames"
          class="field-input min-h-24"
          placeholder="例如: car,bus,truck"
        />
      </div>

      <div
        class="md:col-span-3"
        v-if="form.format === 'coco' || form.format === 'auto'"
      >
        <label class="field-label"
          >coco_annotation_files (COCO 标注文件，可选)</label
        >
        <textarea
          v-model="form.cocoAnnotationFiles"
          class="field-input min-h-24"
          placeholder="每行一个文件，如 annotations/instances_train2017.json"
        />
      </div>

      <div
        class="md:col-span-3"
        v-if="form.format === 'coco' || form.format === 'auto'"
      >
        <label class="field-label">coco_image_root (COCO 图片目录，可选)</label>
        <input
          v-model="form.cocoImageRoot"
          class="field-input"
          placeholder="当图片不在 source_path 下时填写，例如: val2017 或 D:/coco/images"
        />
      </div>

      <div class="md:col-span-3 flex gap-2">
        <button
          class="btn-primary w-full"
          :disabled="loadingConvert"
          @click="convertDataset"
        >
          {{ loadingConvert ? "转换中..." : "开始转换" }}
        </button>
        <button
          class="btn-secondary w-full"
          :disabled="loadingHistory"
          @click="loadHistory"
        >
          {{ loadingHistory ? "刷新中..." : "刷新历史" }}
        </button>
      </div>
    </div>
  </section>

  <section class="card-panel p-5">
    <h3 class="section-title">交通子集筛选</h3>
    <p class="section-subtitle mt-1">
      从 YOLO 格式数据中筛选交通相关类别，自动重映射类别并生成 dataset.yaml。
    </p>

    <div
      class="mt-4 grid gap-3 rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4 md:grid-cols-3"
    >
      <div class="md:col-span-2">
        <label class="field-label">source_path (源目录)</label>
        <input
          v-model="form.trafficSourcePath"
          class="field-input"
          placeholder="例如: dataset_download/coco"
        />
      </div>

      <div>
        <label class="field-label">copy_mode</label>
        <select v-model="form.trafficCopyMode" class="field-input">
          <option value="copy">copy</option>
          <option value="hardlink">hardlink</option>
        </select>
      </div>

      <div>
        <label class="field-label">target_root (输出根目录)</label>
        <input
          v-model="form.trafficTargetRoot"
          class="field-input"
          placeholder="默认: dataset_download"
        />
      </div>

      <div>
        <label class="field-label">output_name (输出目录名)</label>
        <input
          v-model="form.trafficOutputName"
          class="field-input"
          placeholder="默认: coco_traffic"
        />
      </div>

      <div>
        <label class="field-label">splits</label>
        <input
          v-model="form.trafficSplits"
          class="field-input"
          placeholder="例如: train,val,test"
        />
      </div>

      <div class="md:col-span-3">
        <label class="field-label">class_names (逗号或换行分隔)</label>
        <textarea
          v-model="form.trafficClasses"
          class="field-input min-h-24"
          placeholder="例如: car,bus,truck,motorcycle,bicycle"
        />
      </div>

      <div
        class="rounded-xl border border-[var(--line-soft)] bg-white px-3 py-2 text-sm"
      >
        <label class="flex items-center gap-2">
          <input v-model="form.trafficIncludeEmptyLabels" type="checkbox" />
          保留筛选后空标签图片
        </label>
      </div>

      <div
        class="rounded-xl border border-[var(--line-soft)] bg-white px-3 py-2 text-sm"
      >
        <label class="flex items-center gap-2">
          <input v-model="form.trafficOverwrite" type="checkbox" />
          覆盖同名输出目录
        </label>
      </div>

      <div class="md:col-span-3">
        <button
          class="btn-primary w-full"
          :disabled="loadingTraffic"
          @click="extractTrafficSubset"
        >
          {{ loadingTraffic ? "提取中..." : "提取交通子集" }}
        </button>
      </div>
    </div>
  </section>

  <section class="card-panel p-5" v-if="convertResult">
    <h3 class="section-title">最近一次转换结果</h3>
    <div class="mt-3 grid gap-2 md:grid-cols-3">
      <div class="metric-chip">格式: {{ convertResult.format }}</div>
      <div class="metric-chip">图片总数: {{ convertResult.image_count }}</div>
      <div class="metric-chip">类别数: {{ convertResult.class_count }}</div>
      <div class="metric-chip">train: {{ convertResult.train_count }}</div>
      <div class="metric-chip">val: {{ convertResult.val_count }}</div>
      <div class="metric-chip">test: {{ convertResult.test_count }}</div>
      <div class="metric-chip md:col-span-3 break-all">
        dataset.yaml:
        {{
          convertResult.dataset_yaml_relative || convertResult.dataset_yaml_path
        }}
      </div>
      <div class="metric-chip md:col-span-3" v-if="convertResult.skipped_count">
        跳过样本: {{ convertResult.skipped_count }}
      </div>
    </div>
  </section>

  <section class="card-panel p-5" v-if="trafficResult">
    <h3 class="section-title">最近一次交通子集结果</h3>
    <div class="mt-3 grid gap-2 md:grid-cols-3">
      <div class="metric-chip">图片总数: {{ trafficResult.image_count }}</div>
      <div class="metric-chip">
        目标总数: {{ trafficResult.objects_selected }}
      </div>
      <div class="metric-chip">类别数: {{ trafficResult.class_count }}</div>
      <div class="metric-chip">train: {{ trafficResult.train_count }}</div>
      <div class="metric-chip">val: {{ trafficResult.val_count }}</div>
      <div class="metric-chip">test: {{ trafficResult.test_count }}</div>
      <div class="metric-chip md:col-span-3 break-all">
        输出目录:
        {{ trafficResult.dataset_dir_relative || trafficResult.dataset_dir }}
      </div>
      <div class="metric-chip md:col-span-3 break-all">
        dataset.yaml:
        {{
          trafficResult.dataset_yaml_relative || trafficResult.dataset_yaml_path
        }}
      </div>
      <div class="metric-chip md:col-span-3 break-all">
        类别: {{ (trafficResult.classes || []).join(", ") }}
      </div>
    </div>

    <div
      class="mt-4 overflow-x-auto"
      v-if="(trafficResult.split_stats || []).length"
    >
      <table class="w-full min-w-[620px] border-collapse text-left text-sm">
        <thead>
          <tr class="border-b border-[var(--line-soft)] text-[var(--ink-sub)]">
            <th class="px-2 py-2">split</th>
            <th class="px-2 py-2">输入图片</th>
            <th class="px-2 py-2">输出图片</th>
            <th class="px-2 py-2">有标注图片</th>
            <th class="px-2 py-2">筛后为空</th>
            <th class="px-2 py-2">复制失败</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in trafficResult.split_stats"
            :key="item.split"
            class="border-b border-[var(--line-soft)] hover:bg-[#f8fbfa]"
          >
            <td class="px-2 py-2">{{ item.split }}</td>
            <td class="px-2 py-2">{{ item.input_images }}</td>
            <td class="px-2 py-2">{{ item.output_images }}</td>
            <td class="px-2 py-2">{{ item.labeled_images }}</td>
            <td class="px-2 py-2">{{ item.empty_after_filter }}</td>
            <td class="px-2 py-2">{{ item.copy_fail }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="card-panel p-5">
    <div class="flex items-center justify-between gap-2">
      <h3 class="section-title">转换历史（后端持久化）</h3>
      <button
        class="btn-secondary"
        :disabled="loadingHistory"
        @click="clearHistory"
      >
        清空历史
      </button>
    </div>

    <div class="mt-4 overflow-x-auto">
      <table class="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead>
          <tr class="border-b border-[var(--line-soft)] text-[var(--ink-sub)]">
            <th class="px-2 py-2">时间</th>
            <th class="px-2 py-2">格式</th>
            <th class="px-2 py-2">源目录</th>
            <th class="px-2 py-2">输出名</th>
            <th class="px-2 py-2">图片数</th>
            <th class="px-2 py-2">类别数</th>
            <th class="px-2 py-2">dataset.yaml</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in historyItems"
            :key="item.id"
            class="border-b border-[var(--line-soft)] hover:bg-[#f8fbfa]"
          >
            <td class="px-2 py-2">{{ item.time || "--" }}</td>
            <td class="px-2 py-2">{{ item.format }}</td>
            <td class="px-2 py-2 break-all">
              {{ item.source_path_relative || item.source_path }}
            </td>
            <td class="px-2 py-2">{{ item.output_name }}</td>
            <td class="px-2 py-2">{{ item.image_count }}</td>
            <td class="px-2 py-2">{{ item.class_count }}</td>
            <td class="px-2 py-2 break-all">
              {{ item.dataset_yaml_relative || "--" }}
            </td>
          </tr>
          <tr v-if="historyItems.length === 0">
            <td class="px-2 py-4 text-[var(--ink-sub)]" colspan="7">
              暂无历史记录
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
