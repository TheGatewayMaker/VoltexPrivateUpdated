import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { createServer } from "./server";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    fs: {
      allow: [".", "./client", "./shared"],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "server/**"],
    },
  },
  build: {
    outDir: "dist/spa",
    target: ["es2019", "safari13", "chrome88"],
  },
  plugins: [react(), expressPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
}));

function expressPlugin(): Plugin {
  let expressApp: any;
  let expressWss: any;

  return {
    name: "express-plugin",
    apply: "serve", // Only apply during development (serve mode)
    async configureServer(server) {
      const { app, wss } = await createServer();
      expressApp = app;
      expressWss = wss;

      // Use server.middlewares.use to add Express app as middleware
      server.middlewares.use(app);

      // Return a function that handles WebSocket upgrades after HTTP server is ready
      return () => {
        const httpServer = server.httpServer;

        if (!httpServer) {
          console.error(
            "HTTP server not available for WebSocket upgrade handler",
          );
          return;
        }

        // Check if upgrade listener is already attached to avoid duplicates
        const listeners = httpServer.listeners("upgrade");
        const hasWsHandler = listeners.some((listener: any) => {
          return listener.toString().includes("wss.handleUpgrade");
        });

        if (!hasWsHandler) {
          httpServer.on("upgrade", (req: any, socket: any, head: any) => {
            if (req.url?.startsWith("/ws")) {
              wss.handleUpgrade(req, socket, head, (ws: any) => {
                wss.emit("connection", ws, req);
              });
            }
          });
          console.log("WebSocket upgrade handler attached");
        }
      };
    },
  };
}
