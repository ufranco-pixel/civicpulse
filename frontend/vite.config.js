import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Configuracion de Vite.
 *
 * El puerto sale del entorno (PORT) porque en desarrollo conviven varios
 * tableros; `envPrefix` se deja explicito para que nunca se cuele en el bundle
 * una variable que no empiece por VITE_.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number.parseInt(env.PORT || '5173', 10);
  // Proxy opcional: solo se activa si se declara el destino. Sirve para
  // desarrollar contra un backend que no publica CORS para localhost.
  const proxyTarget = env.VITE_DEV_PROXY_TARGET || '';

  return {
    plugins: [react()],
    envPrefix: 'VITE_',

    server: {
      port,
      host: true,
      strictPort: false,
      proxy: proxyTarget
        ? {
            '/api': {
              target: proxyTarget,
              changeOrigin: true,
              secure: false,
              rewrite: (p) => p.replace(/^\/api/, ''),
            },
          }
        : undefined,
    },

    preview: { port, host: true },

    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      // El mapa de fuentes en produccion expone el codigo del tablero; solo
      // se emite fuera de produccion.
      sourcemap: mode !== 'production',
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-vendor')) return 'charts';
            if (id.includes('keycloak-js')) return 'auth';
            if (id.includes('lucide-react')) return 'icons';
            return 'vendor';
          },
        },
      },
    },
  };
});
