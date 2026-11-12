import { defineConfig } from 'vite';

export default defineConfig({
  root: 'plugin/board',
  publicDir: false,
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      ['/api', '/fonts', '/icons'].map((route) => [
        route,
        {
          target: `http://127.0.0.1:${process.env.CREW_PORT ?? 47615}`,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (request, incoming) => {
              // Only this dev server may cross the daemon's origin boundary.
              if (['http://127.0.0.1:5173', 'http://localhost:5173'].includes(incoming.headers.origin ?? '')) {
                request.removeHeader('origin');
              }
            });
          },
        },
      ]),
    ),
  },
});
