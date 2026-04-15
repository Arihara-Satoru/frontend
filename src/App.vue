<script setup>
const navItems = [
  { path: "/", title: "识别中心", desc: "图片/视频/实时识别" },
  { path: "/compare", title: "模型对比", desc: "ECharts 中文对比看板" },
  { path: "/train", title: "训练控制台", desc: "一键启动训练并监控日志" },
  { path: "/annotate", title: "数据标注", desc: "视频切帧/手工标注/自动标注" },
];
</script>

<template>
  <div class="min-h-screen w-full bg-[var(--bg-main)] text-[var(--ink-main)]">
    <header
      class="border-b border-[var(--line-soft)] bg-white/90 backdrop-blur"
    >
      <div
        class="mx-auto flex w-full max-w-none items-center justify-between px-4 py-4 sm:px-6 lg:px-8 xl:px-10"
      >
        <div>
          <h1 class="text-xl font-bold tracking-wide">YOLO 车辆智能识别系统</h1>
          <p class="text-sm text-[var(--ink-sub)]">
            毕业设计 · Vue3 + Tailwind + Python + YOLO
          </p>
        </div>
        <span
          class="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"
        >
          Card + Flat UI
        </span>
      </div>
    </header>

    <main
      class="mx-auto grid w-full max-w-none gap-5 px-4 pb-8 pt-5 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:px-8 xl:px-10"
    >
      <aside class="card-panel p-4">
        <h2
          class="mb-3 text-sm font-bold uppercase tracking-[0.12em] text-[var(--ink-sub)]"
        >
          功能导航
        </h2>
        <nav class="space-y-2">
          <RouterLink
            v-for="item in navItems"
            :key="item.path"
            :to="item.path"
            class="nav-card"
          >
            <div class="text-sm font-semibold">{{ item.title }}</div>
            <div class="text-xs text-[var(--ink-sub)]">{{ item.desc }}</div>
          </RouterLink>
        </nav>
      </aside>

      <section class="min-w-0 space-y-5">
        <RouterView />
      </section>
    </main>
  </div>
</template>
