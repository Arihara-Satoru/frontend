<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

import api from "../utils/http";

const videoFile = ref(null);
const videoFiles = ref([]);
const imageFiles = ref([]);
const imageFileInput = ref(null);
const modelFile = ref(null);

const classText = ref("car,bus,truck");
const frameStep = ref(5);
const maxFrames = ref(200);
const cleanupSourceVideo = ref(true);
const trainRatio = ref(0.8);
const datasetName = ref("");

const sessionId = ref("");
const classList = ref([]);
const selectedClassId = ref(0);

const frames = ref([]);
const frameListVisibleCount = ref(0);
const currentFrameIndex = ref(0);
const currentBoxes = ref([]);
const unsaved = ref(false);
const selectedBoxIndex = ref(-1);

const annotateCanvas = ref(null);
const imageElement = ref(null);
let drawing = false;
let draftBox = null;
let activeInteraction = null;

const MIN_BOX_SIZE = 6;
const HANDLE_SIZE = 5;
const HANDLE_HIT_SIZE = 14;
const FRAME_LIST_PAGE_SIZE = 240;

const loadingUpload = ref(false);
const loadingExtract = ref(false);
const loadingSaveBox = ref(false);
const loadingAutoLabel = ref(false);
const loadingSplit = ref(false);
const loadingAppendFrames = ref(false);
const loadingAppendAllFrames = ref(false);
const loadingClearFrames = ref(false);
const loadingCleanupBackend = ref(false);
const loadingUploadImages = ref(false);
const appendingSessionId = ref("");
const appendedSourceSessionIds = ref([]);

const modelOptions = ref([]);
const selectedModel = ref("yolov8n");
const autoLabelConf = ref(0.25);
const autoLabelDevice = ref("cpu");

const splitResult = ref(null);
const autoLabelResult = ref(null);
const sessionHistory = ref([]);
const batchProgressTotal = ref(0);
const batchProgressDone = ref(0);
const batchCurrentVideoName = ref("");
const batchExtractResults = ref([]);

const currentFrame = computed(
  () => frames.value[currentFrameIndex.value] || null,
);
const selectedVideoCount = computed(() => videoFiles.value.length);
const selectedImageCount = computed(() => imageFiles.value.length);
const appendedSourceSessionIdSet = computed(
  () => new Set(appendedSourceSessionIds.value),
);
const appendableSessionCount = computed(
  () =>
    sessionHistory.value.filter(
      (item) =>
        item.session_id !== sessionId.value &&
        !appendedSourceSessionIdSet.value.has(item.session_id),
    ).length,
);
const visibleFrames = computed(() =>
  frames.value.slice(0, frameListVisibleCount.value),
);
const canLoadMoreFrames = computed(
  () => frameListVisibleCount.value < frames.value.length,
);
const selectedVideoPreviewText = computed(() => {
  if (videoFiles.value.length === 0) {
    return "";
  }

  const names = videoFiles.value.map((file) => file.name);
  if (names.length <= 3) {
    return names.join("、");
  }
  return `${names.slice(0, 3).join("、")} 等 ${names.length} 个视频`;
});
const selectedImagePreviewText = computed(() => {
  if (imageFiles.value.length === 0) {
    return "";
  }

  const names = imageFiles.value.map((file) => file.name);
  if (names.length <= 3) {
    return names.join("、");
  }
  return `${names.slice(0, 3).join("、")} 等 ${names.length} 张图片`;
});

const ANNOTATE_STORAGE_KEY = "annotate_page_state_v1";
let cachePersistPaused = false;

function readAnnotateCache() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(ANNOTATE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("读取标注页缓存失败", error);
    return null;
  }
}

function writeAnnotateCache(payload) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(ANNOTATE_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("写入标注页缓存失败", error);
  }
}

function clearAnnotateCache() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(ANNOTATE_STORAGE_KEY);
  } catch (error) {
    console.warn("清除标注页缓存失败", error);
  }
}

function toFiniteNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return clamp(numeric, min, max);
}

function normalizeSessionHistoryEntry(entry) {
  const nextSessionId = String(entry?.session_id || "").trim();
  if (!nextSessionId) {
    return null;
  }

  const nextClasses = Array.isArray(entry?.classes)
    ? entry.classes.map((name) => String(name).trim()).filter(Boolean)
    : [];

  return {
    session_id: nextSessionId,
    video_name: String(entry?.video_name || nextSessionId),
    frame_count: Math.max(0, Number(entry?.frame_count || 0)),
    classes: nextClasses,
    updated_at: String(entry?.updated_at || new Date().toISOString()),
  };
}

function normalizeSessionHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const item of rawHistory) {
    const nextItem = normalizeSessionHistoryEntry(item);
    if (!nextItem || seen.has(nextItem.session_id)) {
      continue;
    }
    seen.add(nextItem.session_id);
    normalized.push(nextItem);
  }

  return normalized.slice(0, 60);
}

function upsertSessionHistory(entry) {
  const normalized = normalizeSessionHistoryEntry(entry);
  if (!normalized) {
    return;
  }

  const nextHistory = [
    normalized,
    ...sessionHistory.value.filter(
      (item) => item.session_id !== normalized.session_id,
    ),
  ];
  sessionHistory.value = nextHistory.slice(0, 60);
}

function normalizeSessionIdList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const sessionIdText = String(value || "").trim();
    if (!sessionIdText || seen.has(sessionIdText)) {
      continue;
    }
    seen.add(sessionIdText);
    normalized.push(sessionIdText);
  }

  return normalized;
}

function isSessionAlreadyAppended(sourceSessionId) {
  const normalizedSourceSessionId = String(sourceSessionId || "").trim();
  if (!normalizedSourceSessionId) {
    return false;
  }
  return appendedSourceSessionIdSet.value.has(normalizedSourceSessionId);
}

function syncVisibleFrameCount() {
  if (frames.value.length === 0) {
    frameListVisibleCount.value = 0;
    return;
  }

  const minVisible = Math.min(frames.value.length, currentFrameIndex.value + 1);
  frameListVisibleCount.value = Math.min(
    frames.value.length,
    Math.max(FRAME_LIST_PAGE_SIZE, minVisible),
  );
}

function ensureCurrentFrameVisible() {
  const minVisible = Math.min(frames.value.length, currentFrameIndex.value + 1);
  if (minVisible <= frameListVisibleCount.value) {
    return;
  }

  frameListVisibleCount.value = Math.min(
    frames.value.length,
    Math.max(minVisible, frameListVisibleCount.value + FRAME_LIST_PAGE_SIZE),
  );
}

function loadMoreFrames() {
  frameListVisibleCount.value = Math.min(
    frames.value.length,
    frameListVisibleCount.value + FRAME_LIST_PAGE_SIZE,
  );
}

function applyCachedSettings(cached) {
  if (!cached || typeof cached !== "object") {
    return;
  }

  if (typeof cached.classText === "string") {
    classText.value = cached.classText;
  }
  frameStep.value = toFiniteNumber(cached.frameStep, frameStep.value, 1, 5000);
  maxFrames.value = toFiniteNumber(cached.maxFrames, maxFrames.value, 0, 5000);
  if (typeof cached.cleanupSourceVideo === "boolean") {
    cleanupSourceVideo.value = cached.cleanupSourceVideo;
  }
  trainRatio.value = toFiniteNumber(
    cached.trainRatio,
    trainRatio.value,
    0.5,
    0.95,
  );

  if (typeof cached.datasetName === "string") {
    datasetName.value = cached.datasetName;
  }
  if (typeof cached.selectedModel === "string" && cached.selectedModel.trim()) {
    selectedModel.value = cached.selectedModel.trim();
  }
  if (
    typeof cached.autoLabelDevice === "string" &&
    cached.autoLabelDevice.trim()
  ) {
    autoLabelDevice.value = cached.autoLabelDevice.trim();
  }
  autoLabelConf.value = toFiniteNumber(
    cached.autoLabelConf,
    autoLabelConf.value,
    0.05,
    0.95,
  );

  if (cached.splitResult && typeof cached.splitResult === "object") {
    splitResult.value = cached.splitResult;
  }
  if (cached.autoLabelResult && typeof cached.autoLabelResult === "object") {
    autoLabelResult.value = cached.autoLabelResult;
  }

  sessionHistory.value = normalizeSessionHistory(cached.sessionHistory);
}

function persistAnnotateCache() {
  if (cachePersistPaused) {
    return;
  }

  writeAnnotateCache({
    classText: classText.value,
    frameStep: Number(frameStep.value),
    maxFrames: Number(maxFrames.value),
    cleanupSourceVideo: Boolean(cleanupSourceVideo.value),
    trainRatio: Number(trainRatio.value),
    datasetName: datasetName.value,
    sessionId: sessionId.value,
    currentFrameIndex: Number(currentFrameIndex.value),
    selectedClassId: Number(selectedClassId.value),
    selectedModel: selectedModel.value,
    autoLabelConf: Number(autoLabelConf.value),
    autoLabelDevice: autoLabelDevice.value,
    splitResult: splitResult.value,
    autoLabelResult: autoLabelResult.value,
    sessionHistory: sessionHistory.value,
    savedAt: Date.now(),
  });
}

async function clearAllLocalCache() {
  const ok = window.confirm(
    "确定一键清除本页全部本地缓存吗？这不会删除后端会话数据。",
  );
  if (!ok) {
    return;
  }

  cachePersistPaused = true;
  try {
    videoFile.value = null;
    videoFiles.value = [];
    imageFiles.value = [];
    if (imageFileInput.value) {
      imageFileInput.value.value = "";
    }
    modelFile.value = null;

    classText.value = "car,bus,truck";
    frameStep.value = 5;
    maxFrames.value = 200;
    cleanupSourceVideo.value = true;
    trainRatio.value = 0.8;
    datasetName.value = "";

    selectedModel.value = "yolov8n";
    autoLabelConf.value = 0.25;
    autoLabelDevice.value = "cpu";

    sessionHistory.value = [];
    batchProgressTotal.value = 0;
    batchProgressDone.value = 0;
    batchCurrentVideoName.value = "";
    batchExtractResults.value = [];

    resetSessionState();

    await nextTick();
    clearAnnotateCache();
  } finally {
    cachePersistPaused = false;
  }

  alert("本地缓存已清除，页面状态已重置");
}

function formatFileSize(sizeBytes) {
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

async function clearBackendStorage() {
  const keepSessionIds = sessionId.value ? [sessionId.value] : [];
  const confirmMessage = sessionId.value
    ? "确定一键清理后端缓存吗？将删除除当前会话外的所有历史会话目录（视频/帧/标注），且不可恢复。"
    : "当前未选中会话，确定一键清理后端缓存吗？这会删除全部历史会话目录（视频/帧/标注），且不可恢复。";

  const ok = window.confirm(confirmMessage);
  if (!ok) {
    return;
  }

  loadingCleanupBackend.value = true;
  try {
    const response = await api.post(
      "/annotate/sessions/cleanup",
      {
        keep_session_ids: keepSessionIds,
      },
      {
        timeout: 0,
      },
    );

    const data = response.data.data || {};
    const deletedSessionIds = Array.isArray(data.deleted_session_ids)
      ? data.deleted_session_ids
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [];
    const deletedSessionIdSet = new Set(deletedSessionIds);

    if (deletedSessionIdSet.size > 0) {
      sessionHistory.value = sessionHistory.value.filter(
        (item) => !deletedSessionIdSet.has(item.session_id),
      );
    } else if (!sessionId.value) {
      sessionHistory.value = [];
    }

    if (sessionId.value && deletedSessionIdSet.has(sessionId.value)) {
      resetSessionState();
    }

    persistAnnotateCache();

    const deletedCount = Number(data.deleted_count || 0);
    const failedCount = Number(data.failed_count || 0);
    const freedText =
      data.freed_size_human || formatFileSize(Number(data.freed_bytes || 0));
    const remainingText =
      data.remaining_size_human ||
      formatFileSize(Number(data.remaining_bytes || 0));

    if (failedCount > 0) {
      alert(
        `清理完成：删除 ${deletedCount} 个会话，释放约 ${freedText}。另有 ${failedCount} 个会话删除失败，请稍后重试。`,
      );
    } else {
      alert(
        `清理完成：删除 ${deletedCount} 个会话，释放约 ${freedText}。当前后端会话占用约 ${remainingText}。`,
      );
    }
  } catch (error) {
    alert(`后端清理失败: ${error?.response?.data?.message || error.message}`);
  } finally {
    loadingCleanupBackend.value = false;
  }
}

function resetSessionState() {
  sessionId.value = "";
  frames.value = [];
  currentFrameIndex.value = 0;
  currentBoxes.value = [];
  classList.value = [];
  selectedClassId.value = 0;
  selectedBoxIndex.value = -1;
  splitResult.value = null;
  autoLabelResult.value = null;
  appendedSourceSessionIds.value = [];
  unsaved.value = false;
  imageElement.value = null;
  clearInteractionState();
  refreshCanvas();
}

async function loadSessionById(targetSessionId, options = {}) {
  const normalizedTargetSessionId = String(targetSessionId || "").trim();
  if (!normalizedTargetSessionId) {
    throw new Error("会话ID不能为空");
  }

  const {
    preferredFrameIndex = 0,
    preferredClassId = 0,
    fallbackSplitResult = null,
    fallbackAutoLabelResult = null,
  } = options;

  sessionId.value = normalizedTargetSessionId;
  const response = await api.get(
    `/annotate/session/${normalizedTargetSessionId}/frames`,
    {
      params: {
        include_size: 0,
      },
    },
  );
  const data = response.data.data || {};
  const frameRecords = data.frames || [];

  frames.value = frameRecords;
  classList.value = data.classes || [];
  if (classList.value.length > 0) {
    classText.value = classList.value.join(",");
  }

  if (data.last_split && typeof data.last_split === "object") {
    splitResult.value = data.last_split;
  } else if (fallbackSplitResult && typeof fallbackSplitResult === "object") {
    splitResult.value = fallbackSplitResult;
  } else {
    splitResult.value = null;
  }

  if (data.last_auto_label && typeof data.last_auto_label === "object") {
    autoLabelResult.value = data.last_auto_label;
  } else if (
    fallbackAutoLabelResult &&
    typeof fallbackAutoLabelResult === "object"
  ) {
    autoLabelResult.value = fallbackAutoLabelResult;
  } else {
    autoLabelResult.value = null;
  }
  appendedSourceSessionIds.value = normalizeSessionIdList(
    data.merged_source_sessions,
  );

  currentFrameIndex.value = toFiniteNumber(
    preferredFrameIndex,
    0,
    0,
    Math.max(0, frameRecords.length - 1),
  );
  selectedClassId.value = toFiniteNumber(
    preferredClassId,
    0,
    0,
    Math.max(0, classList.value.length - 1),
  );

  const currentSessionHistory = sessionHistory.value.find(
    (item) => item.session_id === normalizedTargetSessionId,
  );

  upsertSessionHistory({
    session_id: normalizedTargetSessionId,
    video_name:
      data.video_name ||
      currentSessionHistory?.video_name ||
      normalizedTargetSessionId,
    frame_count: Number(data.frame_count || frameRecords.length),
    classes: data.classes || currentSessionHistory?.classes || [],
    updated_at: String(data.updated_at || new Date().toISOString()),
  });

  if (frameRecords.length > 0) {
    await loadCurrentFrame();
  } else {
    currentBoxes.value = [];
    imageElement.value = null;
    clearInteractionState();
    refreshCanvas();
  }

  return data;
}

async function reloadCurrentSessionFrames() {
  if (!sessionId.value) {
    return;
  }

  await loadSessionById(sessionId.value, {
    preferredFrameIndex: currentFrameIndex.value,
    preferredClassId: selectedClassId.value,
    fallbackSplitResult: splitResult.value,
    fallbackAutoLabelResult: autoLabelResult.value,
  });
}

async function restoreSessionFromCache(cached) {
  const restoredSessionId = String(cached?.sessionId || "").trim();
  if (!restoredSessionId) {
    return;
  }

  try {
    await loadSessionById(restoredSessionId, {
      preferredFrameIndex: cached?.currentFrameIndex,
      preferredClassId: cached?.selectedClassId,
      fallbackSplitResult: cached?.splitResult,
      fallbackAutoLabelResult: cached?.autoLabelResult,
    });
  } catch (error) {
    console.warn("恢复历史标注会话失败，已清除失效会话", error);
    sessionHistory.value = sessionHistory.value.filter(
      (item) => item.session_id !== restoredSessionId,
    );
    resetSessionState();
  }
}

async function switchSession(targetSessionId) {
  const normalizedTargetSessionId = String(targetSessionId || "").trim();
  if (
    !normalizedTargetSessionId ||
    normalizedTargetSessionId === sessionId.value
  ) {
    return;
  }

  if (unsaved.value) {
    const ok = window.confirm(
      "当前帧有未保存标注，切换会话将丢失未保存内容，确定继续吗？",
    );
    if (!ok) {
      return;
    }
  }

  try {
    await loadSessionById(normalizedTargetSessionId);
  } catch (error) {
    alert(`切换会话失败: ${error.message}`);
  }
}

async function deleteSessionHistory(targetSessionId) {
  const normalizedTargetSessionId = String(targetSessionId || "").trim();
  if (!normalizedTargetSessionId) {
    return;
  }

  if (normalizedTargetSessionId === sessionId.value && unsaved.value) {
    const keepGoing = window.confirm(
      "当前会话存在未保存标注，删除会话会永久丢失这些数据，确定继续吗？",
    );
    if (!keepGoing) {
      return;
    }
  }

  const ok = window.confirm(
    "确定删除该历史会话吗？会同时删除后端会话目录、帧图片和标注文件，且不可恢复。",
  );
  if (!ok) {
    return;
  }

  try {
    await api.delete(`/annotate/session/${normalizedTargetSessionId}`);
  } catch (error) {
    alert(`删除会话失败: ${error?.response?.data?.message || error.message}`);
    return;
  }

  sessionHistory.value = sessionHistory.value.filter(
    (item) => item.session_id !== normalizedTargetSessionId,
  );

  if (normalizedTargetSessionId === sessionId.value) {
    if (sessionHistory.value.length > 0) {
      try {
        await loadSessionById(sessionHistory.value[0].session_id, {
          preferredFrameIndex: 0,
          preferredClassId: 0,
        });
      } catch (error) {
        console.warn("删除当前会话后切换到其它会话失败", error);
        resetSessionState();
      }
    } else {
      resetSessionState();
    }
  }

  persistAnnotateCache();
}

async function appendSessionFrames(sourceSessionId) {
  const normalizedSourceSessionId = String(sourceSessionId || "").trim();
  if (!normalizedSourceSessionId) {
    return;
  }

  if (!sessionId.value) {
    alert("请先点击一个历史会话作为当前会话，再执行添加");
    return;
  }

  if (normalizedSourceSessionId === sessionId.value) {
    alert("当前会话无需重复添加");
    return;
  }

  if (isSessionAlreadyAppended(normalizedSourceSessionId)) {
    alert("该会话已经添加过，无需重复添加");
    return;
  }

  if (unsaved.value) {
    const ok = window.confirm(
      "当前帧有未保存标注，执行添加会刷新帧列表，确定继续吗？",
    );
    if (!ok) {
      return;
    }
  }

  const ok = window.confirm("确定把该会话的帧追加到当前会话吗？");
  if (!ok) {
    return;
  }

  loadingAppendFrames.value = true;
  appendingSessionId.value = normalizedSourceSessionId;

  try {
    const response = await api.post(
      `/annotate/session/${sessionId.value}/append-frames`,
      {
        source_session_id: normalizedSourceSessionId,
        include_frames: false,
        include_size: false,
      },
    );

    const data = response.data.data || {};
    classList.value = data.classes || classList.value;
    appendedSourceSessionIds.value = normalizeSessionIdList(
      data.merged_source_sessions,
    );
    classText.value = classList.value.join(",");

    try {
      await reloadCurrentSessionFrames();
    } catch (refreshError) {
      console.warn("追加后刷新帧列表失败", refreshError);

      upsertSessionHistory({
        session_id: sessionId.value,
        video_name:
          sessionHistory.value.find(
            (item) => item.session_id === sessionId.value,
          )?.video_name || sessionId.value,
        frame_count: Number(data.frame_count || frames.value.length),
        classes: classList.value,
        updated_at: new Date().toISOString(),
      });
    }

    alert(`追加成功：新增 ${Number(data.appended_count || 0)} 帧`);
  } catch (error) {
    alert(`追加失败: ${error?.response?.data?.message || error.message}`);
  } finally {
    loadingAppendFrames.value = false;
    appendingSessionId.value = "";
  }
}

async function appendAllSessionsFrames() {
  if (!sessionId.value) {
    alert("请先选择一个当前会话");
    return;
  }

  const candidateSessions = sessionHistory.value.filter(
    (item) =>
      item.session_id !== sessionId.value &&
      !isSessionAlreadyAppended(item.session_id),
  );

  if (candidateSessions.length === 0) {
    alert("没有可添加的历史会话（可能都已添加过）");
    return;
  }

  if (unsaved.value) {
    const keepGoing = window.confirm(
      "当前帧有未保存标注，一键添加会刷新帧列表，确定继续吗？",
    );
    if (!keepGoing) {
      return;
    }
  }

  const ok = window.confirm(
    `确定一键添加 ${candidateSessions.length} 个历史会话的帧到当前会话吗？`,
  );
  if (!ok) {
    return;
  }

  loadingAppendAllFrames.value = true;

  let successCount = 0;
  let failedCount = 0;
  let latestFrameCount = Number(frames.value.length || 0);

  try {
    for (const item of candidateSessions) {
      appendingSessionId.value = item.session_id;
      try {
        const response = await api.post(
          `/annotate/session/${sessionId.value}/append-frames`,
          {
            source_session_id: item.session_id,
            include_frames: false,
            include_size: false,
          },
        );

        const data = response.data.data || {};
        classList.value = data.classes || classList.value;
        appendedSourceSessionIds.value = normalizeSessionIdList(
          data.merged_source_sessions,
        );
        classText.value = classList.value.join(",");
        latestFrameCount = Number(data.frame_count || latestFrameCount);
        successCount += 1;
      } catch (error) {
        failedCount += 1;
      }
    }

    if (successCount > 0) {
      try {
        await reloadCurrentSessionFrames();
      } catch (refreshError) {
        console.warn("一键追加后刷新帧列表失败", refreshError);

        upsertSessionHistory({
          session_id: sessionId.value,
          video_name:
            sessionHistory.value.find(
              (item) => item.session_id === sessionId.value,
            )?.video_name || sessionId.value,
          frame_count: latestFrameCount,
          classes: classList.value,
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (failedCount > 0) {
      alert(`一键添加完成：成功 ${successCount} 个，失败 ${failedCount} 个。`);
    } else {
      alert(`一键添加完成，共成功添加 ${successCount} 个会话。`);
    }
  } finally {
    loadingAppendAllFrames.value = false;
    appendingSessionId.value = "";
  }
}

function parseClassText(text) {
  const raw = text
    .split(/[,\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(raw)];
}

function onVideoFileChange(event) {
  const files = Array.from(event.target.files || []);
  videoFiles.value = files;
  videoFile.value = files[0] || null;
}

function onImageFilesChange(event) {
  imageFiles.value = Array.from(event.target.files || []);
}

function clearImageUploadSelection() {
  imageFiles.value = [];
  if (imageFileInput.value) {
    imageFileInput.value.value = "";
  }
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeBox(box) {
  return {
    ...box,
    x1: Math.min(box.x1, box.x2),
    y1: Math.min(box.y1, box.y2),
    x2: Math.max(box.x1, box.x2),
    y2: Math.max(box.y1, box.y2),
  };
}

function boxRect(box) {
  const normalized = normalizeBox(box);
  return {
    x: normalized.x1,
    y: normalized.y1,
    w: normalized.x2 - normalized.x1,
    h: normalized.y2 - normalized.y1,
  };
}

function pointInBox(point, box) {
  const normalized = normalizeBox(box);
  return (
    point.x >= normalized.x1 &&
    point.x <= normalized.x2 &&
    point.y >= normalized.y1 &&
    point.y <= normalized.y2
  );
}

function getBoxAtPoint(point) {
  for (let index = currentBoxes.value.length - 1; index >= 0; index -= 1) {
    if (pointInBox(point, currentBoxes.value[index])) {
      return index;
    }
  }
  return -1;
}

function getHandleAtPoint(point, box) {
  const normalized = normalizeBox(box);
  const handles = {
    nw: { x: normalized.x1, y: normalized.y1 },
    ne: { x: normalized.x2, y: normalized.y1 },
    sw: { x: normalized.x1, y: normalized.y2 },
    se: { x: normalized.x2, y: normalized.y2 },
  };

  for (const [name, handlePoint] of Object.entries(handles)) {
    if (
      Math.abs(point.x - handlePoint.x) <= HANDLE_HIT_SIZE &&
      Math.abs(point.y - handlePoint.y) <= HANDLE_HIT_SIZE
    ) {
      return name;
    }
  }

  return null;
}

function setSelectedBox(index) {
  selectedBoxIndex.value = index;
}

function clearInteractionState() {
  drawing = false;
  draftBox = null;
  activeInteraction = null;
}

function updateBoxAtIndex(index, nextBox) {
  currentBoxes.value[index] = normalizeBox(nextBox);
}

function refreshCanvas() {
  const canvas = annotateCanvas.value;
  const ctx = canvas.getContext("2d");
  if (!canvas || !ctx) return;

  const image = imageElement.value;
  if (!image) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  canvas.width = image.width;
  canvas.height = image.height;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  currentBoxes.value.forEach((box, index) => {
    const normalized = normalizeBox(box);
    const color = colorForClass(Number(normalized.class_id || 0));
    const { x, y, w, h } = boxRect(normalized);

    ctx.strokeStyle = color;
    ctx.lineWidth = index === selectedBoxIndex.value ? 3 : 2;
    ctx.strokeRect(x, y, w, h);

    if (index === selectedBoxIndex.value) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      ctx.restore();

      const handles = [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ];
      for (const [handleX, handleY] of handles) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(
          handleX - HANDLE_SIZE,
          handleY - HANDLE_SIZE,
          HANDLE_SIZE * 2,
          HANDLE_SIZE * 2,
        );
        ctx.fill();
        ctx.stroke();
      }
    }

    const className =
      classList.value[Number(normalized.class_id)] ||
      normalized.class_name ||
      "class";
    const text = `${className}`;
    ctx.font = "16px Microsoft YaHei";
    const textWidth = ctx.measureText(text).width;

    ctx.fillStyle = color;
    ctx.fillRect(x, Math.max(0, y - 22), textWidth + 12, 22);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + 6, Math.max(16, y - 6));
  });

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
  const pt = toCanvasPoint(event);

  if (selectedBoxIndex.value >= 0) {
    const selectedBox = currentBoxes.value[selectedBoxIndex.value];
    if (selectedBox) {
      const selectedHandle = getHandleAtPoint(pt, selectedBox);
      if (selectedHandle) {
        activeInteraction = {
          type: "resize",
          index: selectedBoxIndex.value,
          handle: selectedHandle,
          startPoint: pt,
          startBox: normalizeBox(selectedBox),
        };
        drawing = false;
        draftBox = null;
        refreshCanvas();
        return;
      }
    }
  }

  const hitIndex = getBoxAtPoint(pt);
  if (hitIndex >= 0) {
    const hitBox = currentBoxes.value[hitIndex];

    setSelectedBox(hitIndex);
    activeInteraction = {
      type: "move",
      index: hitIndex,
      startPoint: pt,
      startBox: normalizeBox(hitBox),
    };
    drawing = false;
    draftBox = null;
    refreshCanvas();
    return;
  }

  setSelectedBox(-1);
  drawing = true;
  draftBox = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
  activeInteraction = {
    type: "draw",
    startPoint: pt,
  };
  refreshCanvas();
}

function onCanvasMouseMove(event) {
  const pt = toCanvasPoint(event);

  if (activeInteraction?.type === "draw" && draftBox) {
    draftBox.x2 = pt.x;
    draftBox.y2 = pt.y;
    refreshCanvas();
    return;
  }

  if (activeInteraction?.type === "move") {
    const { index, startPoint, startBox } = activeInteraction;
    const targetBox = currentBoxes.value[index];
    if (!targetBox || !imageElement.value) return;

    const width = startBox.x2 - startBox.x1;
    const height = startBox.y2 - startBox.y1;
    const nextX1 = clamp(
      startBox.x1 + (pt.x - startPoint.x),
      0,
      imageElement.value.width - width,
    );
    const nextY1 = clamp(
      startBox.y1 + (pt.y - startPoint.y),
      0,
      imageElement.value.height - height,
    );

    updateBoxAtIndex(index, {
      ...targetBox,
      x1: nextX1,
      y1: nextY1,
      x2: nextX1 + width,
      y2: nextY1 + height,
    });
    unsaved.value = true;
    refreshCanvas();
    return;
  }

  if (activeInteraction?.type === "resize") {
    const { index, handle, startBox } = activeInteraction;
    const targetBox = currentBoxes.value[index];
    if (!targetBox || !imageElement.value) return;

    const canvasWidth = imageElement.value.width;
    const canvasHeight = imageElement.value.height;
    const nextBox = { ...startBox };

    if (handle === "nw") {
      nextBox.x1 = clamp(pt.x, 0, nextBox.x2 - MIN_BOX_SIZE);
      nextBox.y1 = clamp(pt.y, 0, nextBox.y2 - MIN_BOX_SIZE);
    } else if (handle === "ne") {
      nextBox.x2 = clamp(pt.x, nextBox.x1 + MIN_BOX_SIZE, canvasWidth);
      nextBox.y1 = clamp(pt.y, 0, nextBox.y2 - MIN_BOX_SIZE);
    } else if (handle === "sw") {
      nextBox.x1 = clamp(pt.x, 0, nextBox.x2 - MIN_BOX_SIZE);
      nextBox.y2 = clamp(pt.y, nextBox.y1 + MIN_BOX_SIZE, canvasHeight);
    } else if (handle === "se") {
      nextBox.x2 = clamp(pt.x, nextBox.x1 + MIN_BOX_SIZE, canvasWidth);
      nextBox.y2 = clamp(pt.y, nextBox.y1 + MIN_BOX_SIZE, canvasHeight);
    }

    updateBoxAtIndex(index, nextBox);
    unsaved.value = true;
    refreshCanvas();
  }
}

function onCanvasMouseUp(event) {
  if (!activeInteraction) return;

  const pt = toCanvasPoint(event);

  if (activeInteraction.type === "draw" && draftBox) {
    draftBox.x2 = pt.x;
    draftBox.y2 = pt.y;

    const nextBox = normalizeBox(draftBox);
    const width = nextBox.x2 - nextBox.x1;
    const height = nextBox.y2 - nextBox.y1;

    if (width >= MIN_BOX_SIZE && height >= MIN_BOX_SIZE) {
      const classId = Number(selectedClassId.value || 0);
      currentBoxes.value.push({
        class_id: classId,
        class_name: classList.value[classId] || `class_${classId}`,
        ...nextBox,
      });
      setSelectedBox(currentBoxes.value.length - 1);
      unsaved.value = true;
    }
  }

  if (activeInteraction.type !== "draw") {
    unsaved.value = true;
  }

  clearInteractionState();
  refreshCanvas();
}

function onCanvasMouseLeave() {
  if (!activeInteraction) return;

  if (activeInteraction.type === "draw") {
    clearInteractionState();
    refreshCanvas();
  }
}

function onWindowMouseUp(event) {
  if (!activeInteraction) return;

  const canvas = annotateCanvas.value;
  if (!canvas) return;

  onCanvasMouseUp(event);
}

function clearBoxes() {
  currentBoxes.value = [];
  setSelectedBox(-1);
  unsaved.value = true;
  refreshCanvas();
}

function undoBox() {
  currentBoxes.value.pop();
  setSelectedBox(-1);
  unsaved.value = true;
  refreshCanvas();
}

function deleteSelectedBox() {
  if (selectedBoxIndex.value < 0) return;

  currentBoxes.value.splice(selectedBoxIndex.value, 1);
  setSelectedBox(
    Math.min(selectedBoxIndex.value, currentBoxes.value.length - 1),
  );
  unsaved.value = true;
  refreshCanvas();
}

function onWindowKeyDown(event) {
  const target = event.target;
  const tagName = target?.tagName?.toLowerCase();
  const isEditable =
    target?.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select";

  if (isEditable) return;

  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    selectedBoxIndex.value >= 0
  ) {
    event.preventDefault();
    deleteSelectedBox();
  }
}

async function loadModels() {
  try {
    const preferredModel = selectedModel.value;
    const response = await api.get("/annotate/models");
    modelOptions.value = response.data.data || [];
    if (modelOptions.value.length > 0) {
      const matched = modelOptions.value.find(
        (item) => item.id === preferredModel,
      );
      selectedModel.value = matched?.id || modelOptions.value[0].id;
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
  const inputFiles =
    videoFiles.value.length > 0
      ? videoFiles.value
      : videoFile.value
        ? [videoFile.value]
        : [];

  if (inputFiles.length === 0) {
    alert("请先上传视频文件");
    return;
  }

  const parsedClasses = parseClassText(classText.value);
  if (parsedClasses.length === 0) {
    alert("请至少填写一个类别");
    return;
  }

  loadingUpload.value = true;
  loadingExtract.value = true;
  splitResult.value = null;
  autoLabelResult.value = null;
  batchProgressTotal.value = inputFiles.length;
  batchProgressDone.value = 0;
  batchCurrentVideoName.value = "";
  batchExtractResults.value = [];

  const successSessions = [];

  for (const file of inputFiles) {
    batchCurrentVideoName.value = file.name;

    try {
      const createForm = new FormData();
      createForm.append("file", file);
      createForm.append("classes", parsedClasses.join(","));

      const createRes = await api.post("/annotate/session/create", createForm, {
        timeout: 0,
      });
      const createdData = createRes.data.data || {};
      const createdSessionId = String(createdData.session_id || "").trim();
      const createdClasses = createdData.classes || parsedClasses;
      const createdVideoName = createdData.video_name || file.name;

      if (!createdSessionId) {
        throw new Error("后端未返回有效 session_id");
      }

      const extractRes = await api.post(
        "/annotate/session/extract",
        {
          session_id: createdSessionId,
          frame_step: Number(frameStep.value),
          max_frames: Number(maxFrames.value),
          start_frame: 0,
          cleanup_source_video: Boolean(cleanupSourceVideo.value),
        },
        {
          timeout: 0,
        },
      );

      const extractData = extractRes.data.data || {};
      const extractedFrames = extractData.frames || [];
      const extractedClasses = extractData.classes || createdClasses;
      const frameCount = Number(
        extractData.frame_count || extractedFrames.length,
      );
      const sourceVideoDeleted = Boolean(extractData.source_video_deleted);

      upsertSessionHistory({
        session_id: createdSessionId,
        video_name: createdVideoName,
        frame_count: frameCount,
        classes: extractedClasses,
        updated_at: new Date().toISOString(),
      });

      successSessions.push(createdSessionId);
      batchExtractResults.value.unshift({
        video_name: file.name,
        status: "success",
        session_id: createdSessionId,
        frame_count: frameCount,
        message: sourceVideoDeleted
          ? `切帧成功，共 ${frameCount} 帧（已清理源视频）`
          : `切帧成功，共 ${frameCount} 帧`,
      });
    } catch (error) {
      const errorMessage =
        error?.response?.data?.message || error.message || "未知错误";

      batchExtractResults.value.unshift({
        video_name: file.name,
        status: "error",
        message: errorMessage,
      });
    } finally {
      batchProgressDone.value += 1;
    }
  }

  batchExtractResults.value = batchExtractResults.value.slice(0, 60);

  if (successSessions.length > 0) {
    try {
      const targetSessionId = successSessions[successSessions.length - 1];
      await loadSessionById(targetSessionId, {
        preferredFrameIndex: 0,
        preferredClassId: 0,
      });
      selectedClassId.value = 0;
    } catch (error) {
      console.warn("批量切帧后加载会话失败", error);
    }

    const failedCount = inputFiles.length - successSessions.length;
    if (failedCount > 0) {
      alert(
        `批量切帧完成：成功 ${successSessions.length} 个，失败 ${failedCount} 个。`,
      );
    } else {
      alert(`批量切帧完成，共成功 ${successSessions.length} 个视频。`);
    }
  } else {
    resetSessionState();
    alert("批量切帧失败：所有视频均处理失败。请检查日志后重试。");
  }

  batchCurrentVideoName.value = "";
  loadingUpload.value = false;
  loadingExtract.value = false;
}

async function uploadImagesToFrameList() {
  const inputFiles = imageFiles.value;
  if (inputFiles.length === 0) {
    alert("请先选择图片文件");
    return;
  }

  const currentSessionId = String(sessionId.value || "").trim();
  let targetSessionId = currentSessionId;

  if (targetSessionId && unsaved.value) {
    const ok = window.confirm(
      "当前帧有未保存标注，上传图片会刷新帧列表，确定继续吗？",
    );
    if (!ok) {
      return;
    }
  }

  const parsedClasses = parseClassText(classText.value);
  if (!targetSessionId && parsedClasses.length === 0) {
    alert("请至少填写一个类别");
    return;
  }

  loadingUploadImages.value = true;
  try {
    if (!targetSessionId) {
      const createResponse = await api.post("/annotate/session/create-empty", {
        classes: parsedClasses,
        source_name:
          inputFiles.length > 1
            ? `image_batch_${Date.now()}`
            : inputFiles[0].name,
      });

      const createData = createResponse.data.data || {};
      targetSessionId = String(createData.session_id || "").trim();
      if (!targetSessionId) {
        throw new Error("后端未返回有效 session_id");
      }

      upsertSessionHistory({
        session_id: targetSessionId,
        video_name: String(createData.video_name || "图片会话"),
        frame_count: 0,
        classes: createData.classes || parsedClasses,
        updated_at: new Date().toISOString(),
      });
    }

    const formData = new FormData();
    for (const file of inputFiles) {
      formData.append("files", file);
    }
    formData.append("include_frames", "0");
    formData.append("include_size", "0");

    const uploadResponse = await api.post(
      `/annotate/session/${targetSessionId}/upload-frames`,
      formData,
      {
        timeout: 0,
      },
    );
    const uploadData = uploadResponse.data.data || {};

    await loadSessionById(targetSessionId, {
      preferredFrameIndex:
        targetSessionId === currentSessionId ? currentFrameIndex.value : 0,
      preferredClassId: selectedClassId.value,
      fallbackSplitResult: splitResult.value,
      fallbackAutoLabelResult: autoLabelResult.value,
    });

    upsertSessionHistory({
      session_id: targetSessionId,
      video_name:
        sessionHistory.value.find((item) => item.session_id === targetSessionId)
          ?.video_name ||
        (inputFiles.length > 1 ? "图片会话" : inputFiles[0].name),
      frame_count: Number(uploadData.frame_count || frames.value.length),
      classes: uploadData.classes || classList.value,
      updated_at: new Date().toISOString(),
    });

    persistAnnotateCache();
    clearImageUploadSelection();

    const appendedCount = Number(uploadData.appended_count || 0);
    const skippedCount = Number(uploadData.skipped_count || 0);
    alert(
      skippedCount > 0
        ? `上传完成：新增 ${appendedCount} 帧，跳过 ${skippedCount} 个无效文件。`
        : `上传完成：新增 ${appendedCount} 帧。`,
    );
  } catch (error) {
    alert(`图片上传失败: ${error?.response?.data?.message || error.message}`);
  } finally {
    loadingUploadImages.value = false;
  }
}

async function loadFrameAnnotation(frameName) {
  const response = await api.get(
    `/annotate/session/${sessionId.value}/annotation/${frameName}`,
  );
  classList.value = response.data.data.classes || classList.value;
  const imageWidth = Number(response.data.data.image_width || 0);
  const imageHeight = Number(response.data.data.image_height || 0);
  currentBoxes.value = (response.data.data.boxes || []).map((box) =>
    normalizeBox(box),
  );

  if (imageWidth > 0 && imageHeight > 0) {
    const targetFrame = frames.value.find(
      (frame) => frame.frame_name === frameName,
    );
    if (targetFrame) {
      targetFrame.width = imageWidth;
      targetFrame.height = imageHeight;
    }
  }

  setSelectedBox(-1);
  clearInteractionState();
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

function getCanvasCursor() {
  if (selectedBoxIndex.value < 0) return "crosshair";
  if (activeInteraction?.type === "resize") return "nwse-resize";
  if (activeInteraction?.type === "move") return "move";
  return "default";
}

async function switchFrame(index) {
  if (index < 0 || index >= frames.value.length) return;

  if (unsaved.value) {
    const ok = window.confirm("当前帧有未保存标注，确定切换帧吗？");
    if (!ok) return;
  }

  currentFrameIndex.value = index;
  ensureCurrentFrameVisible();
  await loadCurrentFrame();
}

async function deleteFrame(frameName, index) {
  const normalizedFrameName = String(frameName || "").trim();
  if (!sessionId.value || !normalizedFrameName) {
    return;
  }

  if (unsaved.value) {
    const ok = window.confirm(
      "当前帧有未保存标注，删除图片会丢失这些内容，确定继续吗？",
    );
    if (!ok) {
      return;
    }
  }

  const ok = window.confirm(
    `确定删除帧 ${normalizedFrameName} 吗？这会同时删除图片和对应标注。`,
  );
  if (!ok) {
    return;
  }

  const originalCurrentIndex = currentFrameIndex.value;

  try {
    const response = await api.delete(
      `/annotate/session/${sessionId.value}/frame/${normalizedFrameName}`,
    );
    const data = response.data.data || {};
    frames.value = data.frames || [];
    classList.value = data.classes || classList.value;
    classText.value = classList.value.join(",");

    if (frames.value.length === 0) {
      resetSessionState();
    } else {
      let nextIndex = originalCurrentIndex;
      if (index < originalCurrentIndex) {
        nextIndex -= 1;
      } else if (index === originalCurrentIndex) {
        nextIndex = Math.min(originalCurrentIndex, frames.value.length - 1);
      }

      const boundedIndex = Math.max(
        0,
        Math.min(nextIndex, frames.value.length - 1),
      );
      currentFrameIndex.value = boundedIndex;
      await loadCurrentFrame();
    }

    upsertSessionHistory({
      session_id: sessionId.value,
      video_name:
        frames.value.length > 0
          ? sessionHistory.value.find(
              (item) => item.session_id === sessionId.value,
            )?.video_name || sessionId.value
          : sessionId.value,
      frame_count: Number(data.frame_count || frames.value.length),
      classes: data.classes || classList.value,
      updated_at: new Date().toISOString(),
    });

    persistAnnotateCache();
  } catch (error) {
    alert(`删除帧失败: ${error.message}`);
  }
}

async function clearFrameList() {
  if (!sessionId.value) {
    alert("请先创建或切换到一个会话");
    return;
  }

  if (frames.value.length === 0) {
    alert("当前帧列表已为空");
    return;
  }

  if (unsaved.value) {
    const ok = window.confirm(
      "当前帧有未保存标注，清空列表将丢失这些内容，确定继续吗？",
    );
    if (!ok) {
      return;
    }
  }

  const ok = window.confirm("确定清空当前会话的全部帧列表吗？");
  if (!ok) {
    return;
  }

  loadingClearFrames.value = true;

  try {
    const response = await api.delete(
      `/annotate/session/${sessionId.value}/frames`,
    );
    const data = response.data.data || {};

    frames.value = data.frames || [];
    classList.value = data.classes || classList.value;
    classText.value = classList.value.join(",");

    currentFrameIndex.value = 0;
    currentBoxes.value = [];
    selectedBoxIndex.value = -1;
    imageElement.value = null;
    splitResult.value = null;
    autoLabelResult.value = null;
    unsaved.value = false;
    clearInteractionState();
    refreshCanvas();

    upsertSessionHistory({
      session_id: sessionId.value,
      video_name:
        sessionHistory.value.find((item) => item.session_id === sessionId.value)
          ?.video_name || sessionId.value,
      frame_count: Number(data.frame_count || 0),
      classes: classList.value,
      updated_at: new Date().toISOString(),
    });

    persistAnnotateCache();
    alert("当前会话帧列表已清空");
  } catch (error) {
    alert(`清空失败: ${error?.response?.data?.message || error.message}`);
  } finally {
    loadingClearFrames.value = false;
  }
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
    classText.value = classList.value.join(",");
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
      {
        timeout: 0,
      },
    );

    autoLabelResult.value = response.data.data;
    classList.value = response.data.data.classes || classList.value;
    classText.value = classList.value.join(",");

    const refreshRes = await api.get(
      `/annotate/session/${sessionId.value}/frames`,
      {
        params: {
          include_size: 0,
        },
      },
    );
    frames.value = refreshRes.data.data.frames || frames.value;
    splitResult.value = refreshRes.data.data.last_split || splitResult.value;
    autoLabelResult.value =
      refreshRes.data.data.last_auto_label || autoLabelResult.value;
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
      {
        timeout: 0,
      },
    );

    splitResult.value = response.data.data;
    datasetName.value = response.data.data.dataset_name || datasetName.value;
  } catch (error) {
    alert(`划分失败: ${error.message}`);
  } finally {
    loadingSplit.value = false;
  }
}

watch(frames, () => {
  syncVisibleFrameCount();
});

watch(currentFrameIndex, () => {
  ensureCurrentFrameVisible();
});

watch(
  [
    classText,
    frameStep,
    maxFrames,
    cleanupSourceVideo,
    trainRatio,
    datasetName,
    sessionId,
    currentFrameIndex,
    selectedClassId,
    selectedModel,
    autoLabelConf,
    autoLabelDevice,
    splitResult,
    autoLabelResult,
    sessionHistory,
  ],
  () => {
    persistAnnotateCache();
  },
  { deep: true },
);

onMounted(async () => {
  const cached = readAnnotateCache();
  applyCachedSettings(cached);
  await loadModels();
  await restoreSessionFromCache(cached);
  window.addEventListener("keydown", onWindowKeyDown);
  window.addEventListener("mouseup", onWindowMouseUp);
});

onBeforeUnmount(() => {
  persistAnnotateCache();
  window.removeEventListener("keydown", onWindowKeyDown);
  window.removeEventListener("mouseup", onWindowMouseUp);
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
          multiple
          @change="onVideoFileChange"
        />
        <p class="mt-1 text-xs text-[var(--ink-sub)]">
          支持一次选择多个视频并批量切帧。
        </p>
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
        <label class="field-label">最多提取帧数（0代表无上限）</label>
        <input
          v-model.number="maxFrames"
          class="field-input"
          type="number"
          min="0"
          max="5000"
        />
        <label
          class="mt-2 inline-flex items-center gap-2 text-xs text-[var(--ink-sub)]"
        >
          <input
            v-model="cleanupSourceVideo"
            class="h-3.5 w-3.5 accent-emerald-600"
            type="checkbox"
          />
          <span>切帧成功后自动删除源视频（推荐，节省磁盘空间）</span>
        </label>
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
          {{
            loadingUpload || loadingExtract
              ? "处理中..."
              : selectedVideoCount > 1
                ? "批量上传并切帧"
                : "上传并切帧"
          }}
        </button>
      </div>
    </div>

    <div
      v-if="selectedVideoCount > 0"
      class="mt-2 text-xs text-[var(--ink-sub)]"
    >
      已选择 {{ selectedVideoCount }} 个视频：{{ selectedVideoPreviewText }}
    </div>
    <div
      v-if="selectedImageCount > 0"
      class="mt-1 text-xs text-[var(--ink-sub)]"
    >
      已选择 {{ selectedImageCount }} 张图片：{{ selectedImagePreviewText }}
    </div>

    <div class="mt-3 flex flex-wrap gap-2 text-xs text-[var(--ink-sub)]">
      <span class="metric-chip">会话ID: {{ sessionId || "未创建" }}</span>
      <span class="metric-chip">总帧数: {{ frames.length }}</span>
      <span class="metric-chip">类别数: {{ classList.length }}</span>
      <span v-if="batchProgressTotal > 0" class="metric-chip">
        批量进度: {{ batchProgressDone }}/{{ batchProgressTotal }}
      </span>
      <span
        v-if="(loadingUpload || loadingExtract) && batchCurrentVideoName"
        class="metric-chip"
      >
        当前处理: {{ batchCurrentVideoName }}
      </span>
    </div>

    <div class="mt-2 flex flex-wrap justify-end gap-2">
      <button
        class="btn-secondary px-3 py-1 text-xs text-rose-600"
        @click="clearAllLocalCache"
      >
        一键清除本地缓存
      </button>
      <button
        class="btn-secondary px-3 py-1 text-xs text-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="loadingCleanupBackend"
        @click="clearBackendStorage"
      >
        {{ loadingCleanupBackend ? "清理中..." : "一键清理后端缓存" }}
      </button>
    </div>
    <div class="mt-1 text-right text-[11px] text-[var(--ink-sub)]">
      后端清理会删除会话目录中的源视频、切帧和标注文件；若当前已选择会话，将默认保留当前会话。
    </div>

    <div v-if="sessionHistory.length > 0" class="mt-3">
      <div class="flex items-center justify-between gap-2">
        <div class="text-xs font-semibold text-[var(--ink-sub)]">
          历史会话（点击切换）
        </div>
        <button
          class="btn-secondary px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="
            !sessionId ||
            appendableSessionCount === 0 ||
            loadingAppendFrames ||
            loadingAppendAllFrames
          "
          @click="appendAllSessionsFrames"
        >
          {{
            loadingAppendAllFrames
              ? "添加中..."
              : `一键添加(${appendableSessionCount})`
          }}
        </button>
      </div>
      <div class="mt-1 text-[11px] text-[var(--ink-sub)]">
        先点击一个会话作为当前会话，再点其他会话“添加”可把该批次帧追加到当前会话；已添加过的会话会自动禁用。
      </div>
      <div class="mt-2 flex flex-wrap gap-2">
        <div
          v-for="item in sessionHistory"
          :key="item.session_id"
          class="flex items-stretch overflow-hidden rounded-xl border border-[var(--line-soft)] bg-white"
        >
          <button
            class="px-3 py-2 text-left text-xs transition"
            :class="
              item.session_id === sessionId
                ? 'bg-emerald-50 text-[var(--brand)]'
                : 'text-[var(--ink-sub)] hover:bg-emerald-50 hover:text-[var(--brand)]'
            "
            @click="switchSession(item.session_id)"
          >
            <div class="font-semibold">{{ item.video_name }}</div>
            <div class="mt-0.5 opacity-80">{{ item.frame_count }} 帧</div>
          </button>
          <button
            class="border-l border-[var(--line-soft)] px-3 text-xs text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
            :title="
              item.session_id === sessionId
                ? '当前会话不可重复添加'
                : isSessionAlreadyAppended(item.session_id)
                  ? '该会话已添加过'
                  : '添加该会话帧到当前会话'
            "
            :disabled="
              loadingAppendFrames ||
              loadingAppendAllFrames ||
              !sessionId ||
              item.session_id === sessionId ||
              isSessionAlreadyAppended(item.session_id)
            "
            @click.stop="appendSessionFrames(item.session_id)"
          >
            {{
              isSessionAlreadyAppended(item.session_id)
                ? "已添加"
                : loadingAppendFrames && appendingSessionId === item.session_id
                  ? "添加中"
                  : "添加"
            }}
          </button>
          <button
            class="border-l border-[var(--line-soft)] px-3 text-xs text-rose-600 transition hover:bg-rose-50"
            title="删除历史会话（含后端数据）"
            @click.stop="deleteSessionHistory(item.session_id)"
          >
            删除
          </button>
        </div>
      </div>
    </div>

    <div v-if="batchExtractResults.length > 0" class="mt-3">
      <div class="text-xs font-semibold text-[var(--ink-sub)]">
        最近批量处理结果
      </div>
      <div class="mt-2 max-h-36 space-y-1 overflow-auto text-xs">
        <div
          v-for="(item, idx) in batchExtractResults"
          :key="`${item.video_name}-${idx}-${item.session_id || 'none'}`"
          class="rounded-lg border border-[var(--line-soft)] bg-white px-3 py-2"
        >
          <span class="font-semibold">{{ item.video_name }}</span>
          <span
            class="ml-2"
            :class="
              item.status === 'success' ? 'text-emerald-600' : 'text-rose-600'
            "
          >
            {{
              item.status === "success" ? item.message : `失败: ${item.message}`
            }}
          </span>
        </div>
      </div>
    </div>
  </section>

  <section class="grid gap-5 xl:grid-cols-[300px_1fr]">
    <aside class="card-panel p-4 overflow-hidden">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="section-title">帧列表</h3>
        <div class="flex items-center gap-2">
          <button class="btn-secondary px-3 py-1" @click="saveClassList">
            更新类别
          </button>
          <button
            class="btn-secondary px-3 py-1 text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="loadingClearFrames || !sessionId || frames.length === 0"
            @click="clearFrameList"
          >
            {{ loadingClearFrames ? "清空中..." : "清空列表" }}
          </button>
        </div>
      </div>
      <div
        class="mb-3 rounded-xl border border-[var(--line-soft)] bg-[#f8fbfa] p-3"
      >
        <label class="field-label">直接上传图片到帧列表</label>
        <input
          ref="imageFileInput"
          class="field-input"
          type="file"
          accept="image/*"
          multiple
          @change="onImageFilesChange"
        />
        <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span class="text-[11px] text-[var(--ink-sub)]">
            {{
              selectedImageCount > 0
                ? `已选择 ${selectedImageCount} 张：${selectedImagePreviewText}`
                : "支持 jpg/jpeg/png；当前无会话时会自动创建空会话。"
            }}
          </span>
          <button
            class="btn-secondary px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="loadingUploadImages || selectedImageCount === 0"
            @click="uploadImagesToFrameList"
          >
            {{ loadingUploadImages ? "上传中..." : "上传图片" }}
          </button>
        </div>
      </div>
      <div
        v-if="frames.length > 0"
        class="mb-2 flex items-center justify-between text-xs text-[var(--ink-sub)]"
      >
        <span>已显示 {{ visibleFrames.length }} / {{ frames.length }} 帧</span>
        <button
          v-if="canLoadMoreFrames"
          class="btn-secondary px-2 py-1"
          @click="loadMoreFrames"
        >
          加载更多
        </button>
      </div>
      <div class="max-h-[1060px] space-y-2 overflow-auto pr-1">
        <div
          v-for="(frame, index) in visibleFrames"
          :key="frame.frame_name"
          class="flex w-full cursor-pointer items-stretch overflow-hidden rounded-xl border text-left transition"
          :class="[
            index === currentFrameIndex
              ? 'border-[var(--brand)] bg-emerald-50'
              : 'border-[var(--line-soft)] bg-white',
          ]"
          @click="switchFrame(index)"
        >
          <div class="flex-1 p-2">
            <img
              :src="`${frame.image_url}?thumb=1`"
              class="h-24 w-full rounded-lg object-cover"
              loading="lazy"
              decoding="async"
            />
            <div class="mt-1 text-xs font-semibold">{{ frame.frame_name }}</div>
            <div class="mt-1 text-[11px] text-[var(--ink-sub)]">
              {{ frame.width || "--" }} x {{ frame.height || "--" }}
              <span
                class="ml-2"
                :class="frame.has_label ? 'text-emerald-600' : 'text-slate-500'"
              >
                {{ frame.has_label ? "已标注" : "未标注" }}
              </span>
            </div>
          </div>
          <button
            class="border-l border-[var(--line-soft)] px-3 text-xs text-rose-600 transition hover:bg-rose-50"
            title="删除当前帧图片"
            @click.stop="deleteFrame(frame.frame_name, index)"
          >
            删除
          </button>
        </div>
      </div>
    </aside>

    <div class="space-y-5">
      <section class="card-panel p-4">
        <h3 class="section-title">手工标注</h3>
        <div class="flex flex-wrap items-center justify-between gap-2">
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
          鼠标左键拖动绘制框；单击框可选中，拖动四角可调整大小，拖动框内部可移动；按
          Delete 或 Backspace 删除选中框。切换帧前建议先保存。当前框数：{{
            currentBoxes.length
          }}。
        </p>

        <div
          class="mt-3 overflow-auto rounded-xl border border-[var(--line-soft)] bg-[#0f172a] p-2"
        >
          <canvas
            ref="annotateCanvas"
            class="mx-auto max-h-[620px] max-w-full rounded-lg bg-black"
            :style="{ cursor: getCanvasCursor() }"
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
