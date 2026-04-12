# 前端说明（Vue3 + Tailwind + ECharts）

本前端是毕业设计的可视化界面，主要页面如下：

- 识别中心：图片识别、视频识别、实时识别
- 模型对比：一键生成多维度 ECharts 对比图
- 训练控制台：配置训练参数、启动/停止训练、查看日志
- 数据标注：视频切帧、手工标注、自动标注、一键划分训练/验证集

## 启动

```powershell
cd d:\download\毕业设计\frontend
npm install
npm run dev
```

## 构建

```powershell
npm run build
```

## 代理配置

开发环境下通过 `vite.config.js` 代理到后端：

- `/api` -> `http://127.0.0.1:5000`
- `/static` -> `http://127.0.0.1:5000`

## 中文字体与图表

为避免 ECharts 中文乱码/方块，前端统一设置了中文字体栈：

- Microsoft YaHei
- PingFang SC
- SimHei
- Noto Sans CJK SC

## 关键目录

- `src/views/Home.vue`：识别中心
- `src/views/Compare.vue`：模型对比看板
- `src/views/Train.vue`：训练控制台
- `src/views/Annotate.vue`：数据标注与数据集构建
- `src/router/index.js`：路由
- `src/utils/http.js`：Axios 封装
