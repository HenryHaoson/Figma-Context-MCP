import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FigmaMcpServer } from "./server";
import { getServerConfig } from "./config";

export async function startServer(): Promise<void> {
  // Check if we're running in stdio mode (e.g., via CLI)
  const isStdioMode = process.env.NODE_ENV === "cli" || process.argv.includes("--stdio");

  const config = getServerConfig(isStdioMode);

  // In stdio mode, we must have an API key configured
  if (isStdioMode && !config.figmaApiKey) {
    console.error("FIGMA_API_KEY is required for stdio mode (via CLI argument --figma-api-key or .env file)");
    process.exit(1);
  }

  const server = new FigmaMcpServer(config.figmaApiKey);

  if (isStdioMode) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    console.log(`Initializing Figma MCP Server in HTTP mode on port ${config.port}...`);
    if (!config.figmaApiKey) {
      console.log("No API key provided via CLI or environment variables.");
      console.log("You must provide an API key via query parameter: /sse?key=your_figma_api_key");
    }
    await server.startHttpServer(config.port);
  }
}

// If this file is being run directly, start the server
if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
