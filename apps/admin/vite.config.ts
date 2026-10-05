import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 独立后台骨架：仅鉴权入口占位，无业务页。API 基地址通过 VITE_API_BASE_URL 注入（默认相对 /api/v1）。
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
