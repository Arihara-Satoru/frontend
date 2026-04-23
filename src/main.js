import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import "./style.css";

// 应用入口只负责组装根组件、路由和全局样式，不在这里塞业务逻辑。
createApp(App).use(router).mount("#app");
