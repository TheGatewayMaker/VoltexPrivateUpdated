import path from "path";
import * as serverModule from "./index.js";
import express from "express";
import { createServer as createHttpServer } from "http";
import { isTrustedWebSocketOrigin } from "./lib/security.js";
import { flushCloudBackupSync } from "./lib/cloud-backup.js";

async function main() {
  // Verify createServer is available
  if (
    !serverModule.createServer ||
    typeof serverModule.createServer !== "function"
  ) {
    throw new Error(
      "Failed to import createServer function from server module",
    );
  }

  const result = await serverModule.createServer();

  if (!result || typeof result !== "object") {
    throw new Error("createServer did not return a valid object");
  }

  const { app, wss } = result;

  if (!app) {
    throw new Error("createServer returned undefined app");
  }

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";

  // Create HTTP server
  const httpServer = createHttpServer(app);

  // Attach WebSocket server to HTTP server
  if (wss) {
    httpServer.on("upgrade", (request, socket, head) => {
      const originHeader = request.headers.origin;
      if (
        originHeader &&
        typeof originHeader === "string" &&
        !isTrustedWebSocketOrigin(originHeader)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
  }

  // In production, serve the built SPA files
  const __dirname = import.meta.dirname;
  const distPath = path.join(__dirname, "../spa");

  // Serve static files
  app.use(
    express.static(distPath, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store, max-age=0");
          return;
        }

        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          return;
        }

        res.setHeader("Cache-Control", "public, max-age=3600");
      },
    }),
  );

  // Handle React Router - serve index.html for all non-API routes
  app.use((req, res) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith("/api/") || req.path.startsWith("/health")) {
      return res.status(404).json({ error: "API endpoint not found" });
    }

    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(distPath, "index.html"));
  });

  httpServer.listen(port, host, () => {
    console.log(`🚀 Fusion Starter server running on port ${port}`);
    console.log(`📱 Frontend: http://${host}:${port}`);
    console.log(`🔧 API: http://${host}:${port}/api`);
    console.log(`🔌 WebSocket: ws://${host}:${port}`);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("🛑 Received SIGTERM, shutting down gracefully");
    await flushCloudBackupSync();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("🛑 Received SIGINT, shutting down gracefully");
    await flushCloudBackupSync();
    process.exit(0);
  });
}

// Start the server
main().catch((error) => {
  console.error("🔥 Failed to start server:", error);
  process.exit(1);
});
