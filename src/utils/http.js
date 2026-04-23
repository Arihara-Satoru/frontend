import axios from "axios";

// 统一封装前端到后端的请求实例，所有页面都通过这里访问 /api，便于集中处理超时和错误提示。
const api = axios.create({
  baseURL: "/api",
  timeout: 1800000,
});

// 响应拦截器只保留后端 message 或 Axios 错误信息，调用方可以直接显示给用户。
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message =
      error?.response?.data?.message || error.message || "请求失败";
    return Promise.reject(new Error(message));
  },
);

export default api;
