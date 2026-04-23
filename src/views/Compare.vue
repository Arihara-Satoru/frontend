<script setup>
import { nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import * as echarts from "echarts";

import api from "../utils/http";

// 对比页的核心目标是把多模型结果统一到同一张看板里，方便横向比较速度、置信度和综合评分。
const modelList = ref([]);
const selectedMap = reactive({});
const conf = ref(0.35);
const selectedDevice = ref("cpu");
const mediaFiles = ref([]);

const compareLoading = ref(false);
const compareResults = ref([]);
const recommendation = ref("");
const sampleCount = ref(0);

const speedChartRef = ref(null);
const countChartRef = ref(null);
const confChartRef = ref(null);
const radarChartRef = ref(null);
const scatterChartRef = ref(null);
const pieChartRef = ref(null);

let speedChart;
let countChart;
let confChart;
let radarChart;
let scatterChart;
let pieChart;

const chartFont =
  "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, SimHei, sans-serif";
// 本地缓存键用于保存阈值、设备和已选模型，避免刷新后重新勾选。
const COMPARE_PAGE_STORAGE_KEY = "compare_page_state_v1";
const preferredModelIds = ref([]);

// 读取缓存时只接受对象型数据，避免损坏的 localStorage 值影响页面。
function readCompareCache() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(COMPARE_PAGE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("读取模型对比页缓存失败", error);
    return null;
  }
}

// 写缓存只是保存轻量状态，不保存真正的对比结果，结果仍以当前查询为准。
function writeCompareCache(payload) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      COMPARE_PAGE_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch (error) {
    console.warn("写入模型对比页缓存失败", error);
  }
}

// 数值字段统一做区间约束，避免阈值滑条或缓存值越界。
function toBoundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

// 从缓存恢复当前对比配置，只恢复可安全回填的字段。
function applyCompareCache(cached) {
  if (!cached || typeof cached !== "object") {
    return;
  }

  conf.value = toBoundedNumber(cached.conf, conf.value, 0.1, 0.9);

  if (
    typeof cached.selectedDevice === "string" &&
    cached.selectedDevice.trim()
  ) {
    selectedDevice.value = cached.selectedDevice.trim();
  }

  if (Array.isArray(cached.selectedModelIds)) {
    preferredModelIds.value = cached.selectedModelIds
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
}

// 只要筛选条件变化，就立即把当前状态写回缓存。
function persistCompareCache() {
  writeCompareCache({
    conf: Number(conf.value),
    selectedDevice: selectedDevice.value,
    selectedModelIds: getSelectedModels(),
    savedAt: Date.now(),
  });
}

// 根据后端返回的模型列表同步勾选状态，保证已不存在的模型不会残留在界面里。
function syncSelectedModels(models) {
  const nextIds = new Set(models.map((item) => item.id));

  for (const key of Object.keys(selectedMap)) {
    if (!nextIds.has(key)) {
      delete selectedMap[key];
    }
  }

  for (const item of models) {
    if (!(item.id in selectedMap)) {
      selectedMap[item.id] = true;
    }
  }
}

// 初始化时同时拉模型列表和设备信息，既决定下拉框内容，也决定默认运行设备。
async function loadSystemInfo() {
  const preferredDevice = selectedDevice.value;

  try {
    const [modelsRes, deviceRes] = await Promise.all([
      api.get("/system/models"),
      api.get("/system/device"),
    ]);
    modelList.value = (modelsRes.data.data || []).filter((item) => item.exists);
    syncSelectedModels(modelList.value);

    if (preferredModelIds.value.length > 0) {
      const preferredSet = new Set(preferredModelIds.value);
      let hitCount = 0;
      for (const item of modelList.value) {
        const checked = preferredSet.has(item.id);
        selectedMap[item.id] = checked;
        if (checked) {
          hitCount += 1;
        }
      }

      if (hitCount === 0) {
        syncSelectedModels(modelList.value);
      }
    }

    const autoDevice = deviceRes.data.data.selected_device || "cpu";
    const supportedDevices = ["cpu", autoDevice];
    if (String(deviceRes.data.data.selected_device || "").startsWith("cuda")) {
      supportedDevices.push("cuda:0");
    }
    selectedDevice.value = supportedDevices.includes(preferredDevice)
      ? preferredDevice
      : autoDevice;
  } catch (error) {
    alert(`加载模型信息失败: ${error.message}`);
  }
}

// 上传文件只负责更新待对比样本，真正识别由后面的对比按钮触发。
function onFileChange(event) {
  mediaFiles.value = Array.from(event.target.files || []);
}

// 从当前勾选状态里提取模型 id 列表，作为后端对比请求的输入。
function getSelectedModels() {
  return modelList.value
    .filter((item) => selectedMap[item.id])
    .map((item) => item.id);
}

// ECharts 实例在挂载后一次性初始化，后续只更新 option，不重复创建容器。
function initCharts() {
  if (speedChartRef.value) speedChart = echarts.init(speedChartRef.value);
  if (countChartRef.value) countChart = echarts.init(countChartRef.value);
  if (confChartRef.value) confChart = echarts.init(confChartRef.value);
  if (radarChartRef.value) radarChart = echarts.init(radarChartRef.value);
  if (scatterChartRef.value) scatterChart = echarts.init(scatterChartRef.value);
  if (pieChartRef.value) pieChart = echarts.init(pieChartRef.value);
}

// 多个图表共享统一的标题、字体和坐标轴留白配置，减少重复样式定义。
function baseOption(title) {
  return {
    title: {
      text: title,
      left: 8,
      top: 6,
      textStyle: {
        fontFamily: chartFont,
        fontSize: 14,
        fontWeight: 700,
      },
    },
    textStyle: {
      fontFamily: chartFont,
    },
    grid: {
      left: 42,
      right: 16,
      top: 54,
      bottom: 42,
    },
    tooltip: {
      trigger: "axis",
    },
  };
}

// 这里把后端返回的每个模型结果拆成多个图表需要的数值序列。
function renderCharts() {
  const results = compareResults.value;
  if (!results.length) return;

  const names = results.map((item) => item.model_name);
  const inferVals = results.map((item) => item.avg_inference_ms);
  const countVals = results.map((item) => item.avg_vehicle_count);
  const confVals = results.map((item) =>
    Number((item.avg_confidence * 100).toFixed(2)),
  );
  const scoreVals = results.map((item) => item.overall_score);

  speedChart?.setOption({
    ...baseOption("推理耗时对比（ms）"),
    xAxis: { type: "category", data: names },
    yAxis: { type: "value", name: "ms" },
    series: [
      {
        type: "bar",
        data: inferVals,
        itemStyle: { color: "#0b9a72" },
        barMaxWidth: 42,
      },
    ],
  });

  countChart?.setOption({
    ...baseOption("车辆检出数量对比"),
    xAxis: { type: "category", data: names },
    yAxis: { type: "value", name: "数量" },
    series: [
      {
        type: "bar",
        data: countVals,
        itemStyle: { color: "#ff9f43" },
        barMaxWidth: 42,
      },
    ],
  });

  confChart?.setOption({
    ...baseOption("平均置信度对比（%）"),
    xAxis: { type: "category", data: names },
    yAxis: { type: "value", name: "%" },
    series: [
      {
        type: "line",
        smooth: true,
        data: confVals,
        symbolSize: 10,
        areaStyle: { color: "rgba(11, 154, 114, 0.12)" },
        itemStyle: { color: "#0b9a72" },
      },
    ],
  });

  radarChart?.setOption({
    title: {
      text: "综合能力雷达图",
      left: 8,
      top: 6,
      textStyle: {
        fontFamily: chartFont,
        fontSize: 14,
        fontWeight: 700,
      },
    },
    textStyle: { fontFamily: chartFont },
    legend: {
      bottom: 6,
      data: names,
    },
    radar: {
      indicator: [
        { name: "速度评分", max: 120 },
        { name: "置信度评分", max: 100 },
        { name: "检出评分", max: 100 },
        { name: "综合评分", max: 100 },
      ],
      radius: 95,
    },
    series: [
      {
        type: "radar",
        data: results.map((item) => ({
          name: item.model_name,
          value: [
            item.speed_score,
            item.confidence_score,
            item.count_score,
            item.overall_score,
          ],
        })),
      },
    ],
  });

  scatterChart?.setOption({
    ...baseOption("速度-置信度散点图"),
    tooltip: {
      trigger: "item",
      formatter: (params) => {
        const row = params.data.meta;
        return `${row.model_name}<br/>耗时: ${row.avg_inference_ms} ms<br/>置信度: ${(row.avg_confidence * 100).toFixed(2)}%`;
      },
    },
    xAxis: { type: "value", name: "耗时(ms)" },
    yAxis: { type: "value", name: "置信度(%)" },
    series: [
      {
        type: "scatter",
        symbolSize: 16,
        data: results.map((item) => ({
          value: [
            item.avg_inference_ms,
            Number((item.avg_confidence * 100).toFixed(2)),
          ],
          meta: item,
        })),
        itemStyle: { color: "#1768ac" },
      },
    ],
  });

  pieChart?.setOption({
    title: {
      text: "综合得分占比",
      left: 8,
      top: 6,
      textStyle: {
        fontFamily: chartFont,
        fontSize: 14,
        fontWeight: 700,
      },
    },
    textStyle: { fontFamily: chartFont },
    tooltip: { trigger: "item" },
    legend: { bottom: 6 },
    series: [
      {
        type: "pie",
        radius: ["35%", "65%"],
        center: ["50%", "55%"],
        data: names.map((name, index) => ({ name, value: scoreVals[index] })),
      },
    ],
  });
}

// 响应窗口大小变化时统一重绘所有图表，防止布局缩放后出现裁切。
function resizeAllCharts() {
  speedChart?.resize();
  countChart?.resize();
  confChart?.resize();
  radarChart?.resize();
  scatterChart?.resize();
  pieChart?.resize();
}

// 发起对比前需要同时具备样本文件和至少一个选中的模型。
async function compareModels() {
  if (!mediaFiles.value.length) {
    alert("请先上传至少一张用于对比的图片");
    return;
  }

  const selectedModels = getSelectedModels();
  if (!selectedModels.length) {
    alert("请至少选择一个模型");
    return;
  }

  compareLoading.value = true;
  try {
    const form = new FormData();
    for (const file of mediaFiles.value) {
      form.append("files", file);
    }
    form.append("models", selectedModels.join(","));
    form.append("conf", String(conf.value));
    form.append("device", selectedDevice.value);

    const response = await api.post("/compare/models", form);
    const payload = response.data.data;
    compareResults.value = payload.results;
    recommendation.value = payload.recommendation;
    sampleCount.value = payload.sample_count || mediaFiles.value.length;

    renderCharts();
  } catch (error) {
    alert(`模型对比失败: ${error.message}`);
  } finally {
    compareLoading.value = false;
  }
}

// 影响对比阈值和设备的设置变化后，马上保存到本地缓存。
watch(
  [conf, selectedDevice],
  () => {
    persistCompareCache();
  },
  { deep: true },
);

// 模型勾选变化同样写入缓存，刷新后可以直接复原上一次对比选择。
watch(
  selectedMap,
  () => {
    persistCompareCache();
  },
  { deep: true },
);

// 挂载时先恢复缓存，再同步系统信息并初始化图表实例。
onMounted(async () => {
  const cached = readCompareCache();
  applyCompareCache(cached);
  await loadSystemInfo();
  await nextTick();
  initCharts();
  window.addEventListener("resize", resizeAllCharts);
});

// 卸载前保存状态、移除窗口监听并释放 ECharts 资源。
onUnmounted(() => {
  persistCompareCache();
  window.removeEventListener("resize", resizeAllCharts);
  speedChart?.dispose();
  countChart?.dispose();
  confChart?.dispose();
  radarChart?.dispose();
  scatterChart?.dispose();
  pieChart?.dispose();
});
</script>

<template>
  <section class="card-panel p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="section-title">模型对比分析</h2>
        <p class="section-subtitle mt-1">
          一键输出多维图表，支持中文标签与中文字体渲染
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <div class="metric-chip">
          样本数: {{ sampleCount || mediaFiles.length || "--" }}
        </div>
        <div class="metric-chip">推荐模型: {{ recommendation || "--" }}</div>
      </div>
    </div>

    <div
      class="mt-4 grid gap-3 rounded-2xl border border-[var(--line-soft)] bg-[#f8fbfa] p-4 md:grid-cols-4"
    >
      <div>
        <label class="field-label">样本图片</label>
        <input
          type="file"
          accept="image/*"
          multiple
          @change="onFileChange"
          class="field-input"
        />
        <p class="mt-2 text-xs text-[var(--ink-sub)]">
          已选择 {{ mediaFiles.length }} 张图片，系统会逐张测试后取平均值
        </p>
      </div>

      <div>
        <label class="field-label">设备</label>
        <select v-model="selectedDevice" class="field-input">
          <option value="cpu">cpu</option>
          <option value="cuda:0">cuda:0</option>
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
          class="btn-primary w-full"
          @click="compareModels"
          :disabled="compareLoading"
        >
          {{ compareLoading ? "对比中..." : "一键模型对比" }}
        </button>
      </div>
    </div>

    <div class="mt-4 flex flex-wrap gap-2">
      <label
        v-for="item in modelList"
        :key="item.id"
        class="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--line-soft)] bg-white px-3 py-2 text-sm"
      >
        <input v-model="selectedMap[item.id]" type="checkbox" />
        {{ item.display_name }}
      </label>
    </div>

    <div v-if="compareResults.length" class="mt-5 overflow-x-auto">
      <table class="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead>
          <tr class="border-b border-[var(--line-soft)] text-[var(--ink-sub)]">
            <th class="py-2">模型</th>
            <th class="py-2">推理耗时(ms)</th>
            <th class="py-2">平均车辆数</th>
            <th class="py-2">平均置信度</th>
            <th class="py-2">最大置信度</th>
            <th class="py-2">前车距离(m)</th>
            <th class="py-2">综合评分</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in compareResults"
            :key="row.model_name"
            class="border-b border-[var(--line-soft)]"
          >
            <td class="py-2 font-semibold">{{ row.model_name }}</td>
            <td class="py-2">{{ row.avg_inference_ms }}</td>
            <td class="py-2">{{ row.avg_vehicle_count }}</td>
            <td class="py-2">{{ (row.avg_confidence * 100).toFixed(2) }}%</td>
            <td class="py-2">{{ (row.max_confidence * 100).toFixed(2) }}%</td>
            <td class="py-2">{{ row.avg_front_distance_m }}</td>
            <td class="py-2 text-[var(--brand)]">{{ row.overall_score }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="grid gap-4 md:grid-cols-2">
    <div ref="speedChartRef" class="card-panel h-[300px] p-2"></div>
    <div ref="countChartRef" class="card-panel h-[300px] p-2"></div>
    <div ref="confChartRef" class="card-panel h-[300px] p-2"></div>
    <div ref="radarChartRef" class="card-panel h-[300px] p-2"></div>
    <div ref="scatterChartRef" class="card-panel h-[300px] p-2"></div>
    <div ref="pieChartRef" class="card-panel h-[300px] p-2"></div>
  </section>
</template>
