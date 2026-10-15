import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const customLogger = createLogger();
const originalError = customLogger.error.bind(customLogger);
customLogger.error = (msg, options) => {
  if (typeof msg === 'string' && (msg.includes('ECONNREFUSED') || msg.includes('http proxy error'))) {
    return;
  }
  originalError(msg, options);
};

// `vite --mode phone` serves over HTTPS on the local network so phones can open
// the app and use the camera (browsers only allow the camera on HTTPS).
export default defineConfig(({ mode }) => {
  const phone = mode === 'phone';
  return {
    customLogger,
    plugins: [react(), tailwindcss(), ...(phone ? [basicSsl()] : [])],
    server: {
      host: phone ? '0.0.0.0' : '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4000',
          changeOrigin: true,
          configure: (proxy) => {
            proxy.removeAllListeners('error');
            proxy.on('error', (err, _req, res) => {
              if ((err as any).code === 'ECONNREFUSED') {
                if (res && 'writeHead' in res && !(res as any).headersSent) {
                  (res as any).writeHead(503, { 'Content-Type': 'application/json' });
                  (res as any).end(JSON.stringify({ error: 'Server starting' }));
                }
                return;
              }
              console.error('[vite proxy error]:', (err as any).message);
            });
          },
        },
      },
    },
  };
});
