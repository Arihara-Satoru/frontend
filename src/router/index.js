import { createRouter, createWebHistory } from "vue-router";

import Home from "../views/Home.vue";
import Compare from "../views/Compare.vue";
import Train from "../views/Train.vue";
import Annotate from "../views/Annotate.vue";
import DatasetOrganizer from "../views/DatasetOrganizer.vue";

// 路由表集中定义了每个功能页的入口，方便后续扩展导航和权限控制。
const routes = [
  { path: "/", name: "home", component: Home },
  { path: "/compare", name: "compare", component: Compare },
  { path: "/train", name: "train", component: Train },
  { path: "/annotate", name: "annotate", component: Annotate },
  {
    path: "/dataset",
    name: "dataset",
    component: DatasetOrganizer,
  },
];

// 使用 history 模式让 URL 更干净，也和常规 Web 应用的路径风格一致。
const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
