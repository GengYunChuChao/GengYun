import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 独立后台：账号目录（读）+ 资料管理（来源/科普/分类，读写）。
// API 基地址通过 VITE_API_BASE_URL 注入（默认相对 /api/v1）。
// 服务端（services/api/src/app.ts）没有配置 CORS，所以开发期必须走同源代理。
// 目标对齐 API 的 API_PORT（services/api/src/config.ts 缺省 3000）。
// 换端口时改这一行（本包没有 @types/node，刻意不读 process.env）。
const API_DEV_ORIGIN = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: API_DEV_ORIGIN,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
