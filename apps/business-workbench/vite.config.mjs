import { defineConfig } from 'vite';
import semiTheming from '@douyinfe/semi-vite-plugin';

export default defineConfig({
  plugins: [semiTheming({ theme: '@semi-bot/semi-theme-feishu' })],
  build: { outDir: 'dist', sourcemap: false },
  // The private JSON is only available through the dedicated loopback server.
  publicDir: false,
});
