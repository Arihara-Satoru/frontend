import { createRouter, createWebHistory } from "vue-router";

import Home from "../views/Home.vue";
import Compare from "../views/Compare.vue";
import Train from "../views/Train.vue";
import Annotate from "../views/Annotate.vue";
import DatasetOrganizer from "../views/DatasetOrganizer.vue";

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

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
