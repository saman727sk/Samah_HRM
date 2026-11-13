import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Public addresses that may open the app (Vite blocks unknown hosts):
// Cloudflare quick tunnels, ngrok, plus any extra host in PUBLIC_HOST (e.g. hrm.yourdomain.com).
const allowedHosts = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', ...(process.env.PUBLIC_HOST ? [process.env.PUBLIC_HOST] : [])]
// The API runs separately (npm run dev:server); proxy it so the app and API share an origin.
const proxy = { '/api': process.env.API_URL ?? 'http://localhost:4000' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Fixed port so stray dev servers on 5173/5174 can't steal it.
    port: 5300,
    host: true, // also reachable from phones/laptops on the same network
    strictPort: true,
    allowedHosts,
    proxy,
  },
  // `npm run share`: the built app (a few files instead of hundreds), fast enough through a tunnel.
  preview: { port: 5301, host: true, strictPort: true, allowedHosts, proxy },
})
