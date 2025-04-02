# Figma-Context-MCP Fork

This repository is a fork of [GLips/Figma-Context-MCP](https://github.com/GLips/Figma-Context-MCP) with additional features and improvements.

👉 Please refer to the [original README](https://github.com/GLips/Figma-Context-MCP/blob/main/README.md) for full documentation.

## New Features in this Fork

### 1. Enhanced Docker Support

This repository includes improved Docker support for easy deployment of the Figma Context MCP server, **particularly beneficial for Windows users** who may face issues running node-based applications. Windows environments often have varying configurations that can lead to dependency conflicts or unexpected behavior. Docker standardizes this environment.

Docker encapsulates the entire runtime environment, including the operating system libraries, Node.js version, and all dependencies. This ensures that the server runs identically regardless of the host system.

### 2. Improved Image Naming Convention

The default image name has been changed to follow the more common naming pattern with a "mcp/" prefix:

```
mcp/figma-context-mcp
```

This makes it easier for users to see all their MCP images when listing them in alphabetical order.

### 3. Simplified Configuration

The Docker build command and example JSON config file settings have been moved to the main README from the DOCKER.md file for easier access. The configuration examples now include the complete "mcpServers" section to assist first-time users.

### 4. Security Notice for Docker SSE Deployment

**⚠️ Security Warning:** When deploying the Docker container and using the SSE endpoint with query parameters (`/sse?key=your_figma_api_key`), please be aware that your Figma API key will be visible in the URL. This approach should only be used in secure environments where URL parameters cannot be intercepted or logged by unauthorized parties. For production or public-facing deployments, consider using environment variables or a more secure configuration method instead.

## Docker Setup

### Building the Docker Image

```bash
docker build -t mcp/figma-context-mcp .
```

### JSON Config for Claude/Cline

```json
{
  "mcpServers": {
    "figma-context-mcp": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "mcp/figma-context-mcp"],
      "env": {
        "FIGMA_API_KEY": "<your-figma-api-key>"
      }
    }
  }
}
```

## Multiple Transport Support

If you need to support multiple users, consider modifying the server implementation to add multiple transports. You can reference the implementation example here: [server.ts#L312-L337](https://github.com/HenryHaoson/Figma-Context-MCP/blob/main/src/server.ts#L312-L337)
