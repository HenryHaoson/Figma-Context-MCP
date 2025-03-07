import { config } from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Load environment variables from .env file
config();

interface ServerConfig {
  figmaApiKey: string;
  port: number;
  configSources: {
    figmaApiKey: "cli" | "env" | "none";
    port: "cli" | "env" | "default";
  };
}

function maskApiKey(key: string): string {
  if (key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

interface CliArgs {
  "figma-api-key"?: string;
  port?: number;
}

export function getServerConfig(isStdioMode: boolean): ServerConfig {
  // Parse command line arguments
  const argv = yargs(hideBin(process.argv))
    .options({
      "figma-api-key": {
        type: "string",
        description: "Figma API key",
      },
      port: {
        type: "number",
        description: "Port to run the server on",
      },
    })
    .help()
    .parseSync() as CliArgs;

  const config: ServerConfig = {
    figmaApiKey: "",
    port: 3333,
    configSources: {
      figmaApiKey: "env",
      port: "default",
    },
  };

  // Handle FIGMA_API_KEY
  if (argv["figma-api-key"]) {
    config.figmaApiKey = argv["figma-api-key"];
    config.configSources.figmaApiKey = "cli";
  } else if (process.env.FIGMA_API_KEY) {
    config.figmaApiKey = process.env.FIGMA_API_KEY;
    config.configSources.figmaApiKey = "env";
  }

  // Handle PORT
  if (argv.port) {
    config.port = argv.port;
    config.configSources.port = "cli";
  } else if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
    config.configSources.port = "env";
  }

  // In HTTP mode, we don't need to validate figmaApiKey here
  // as it can be provided via query parameters
  if (!config.figmaApiKey && process.env.NODE_ENV !== "development") {
    console.warn("No FIGMA_API_KEY found via CLI or .env file");
    console.warn("API key must be provided via query parameter (e.g., /sse?key=your_figma_api_key)");
    config.configSources.figmaApiKey = "none";
  }

  // Log configuration sources
  if (!isStdioMode) {
    console.log("\nConfiguration:");
    console.log(
      `- FIGMA_API_KEY: ${maskApiKey(config.figmaApiKey)} (source: ${config.configSources.figmaApiKey})`,
    );
    console.log(`- PORT: ${config.port} (source: ${config.configSources.port})`);
    console.log(); // Empty line for better readability
  }

  return config;
}
