// @ts-nocheck
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService } from "./services/figma";
import express from "express";
import type { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "http";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SimplifiedDesign } from "./services/simplify-node-response";
import type { GetImagesResponse, GetImageFillsResponse } from "@figma/rest-api-spec";

export const Logger = {
  debug: (...args: any[]) => {
    console.debug(`[${new Date().toISOString()}] [DEBUG]`, ...args);
  },
  log: (...args: any[]) => {
    console.log(`[${new Date().toISOString()}] [INFO]`, ...args);
  },
  warn: (...args: any[]) => {
    console.warn(`[${new Date().toISOString()}] [WARN]`, ...args);
  },
  error: (...args: any[]) => {
    console.error(`[${new Date().toISOString()}] [ERROR]`, ...args);
  },
};

export class FigmaMcpServer {
  private readonly server: McpServer;
  private sseTransport: SSEServerTransport | null = null;
  private apiKeyRequired: boolean = true;
  private apiKey: string;

  constructor(figmaApiKey: string) {
    Logger.log("初始化 FigmaMcpServer...");
    // If figmaApiKey is empty, we'll expect it via query params
    this.apiKeyRequired = !!figmaApiKey;
    this.apiKey = figmaApiKey;
    Logger.log(`API 密钥是否必需: ${this.apiKeyRequired}`);
    
    Logger.log("创建 McpServer 实例...");
    this.server = new McpServer(
      {
        name: "Figma MCP Server",
        version: "0.1.7",
      },
      {
        capabilities: {
          logging: {},
          tools: {},
        },
      },
    );
    Logger.log("McpServer 创建完成");

    Logger.log("注册工具...");
    this.registerTools();
    Logger.log("工具注册完成");
  }

  private getFigmaService(): FigmaService {
    Logger.debug("创建新的 FigmaService 实例");
    // 创建一个新的FigmaService实例，每次调用都是会话级别的
    return new FigmaService(this.apiKey);
  }

  private updateApiKey(newApiKey: string): void {
    Logger.log(`更新 API 密钥: ${newApiKey ? '******' + newApiKey.slice(-4) : '未提供'}`);
    this.apiKey = newApiKey;
  }

  private registerTools(): void {
    Logger.log("开始注册 MCP 工具...");
    
    // Tool to get file information
    Logger.debug("注册 get_figma_data 工具...");
    this.server.tool(
      "get_figma_data",
      "When the nodeId cannot be obtained, obtain the layout information about the entire Figma file",
      {
        fileKey: z
          .string()
          .describe(
            "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
          ),
        nodeId: z
          .string()
          .optional()
          .describe(
            "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided",
          ),
        depth: z
          .number()
          .optional()
          .describe(
            "How many levels deep to traverse the node tree, only use if explicitly requested by the user",
          ),
      },
      async ({ fileKey, nodeId, depth }) => {
        Logger.log(`执行 get_figma_data: fileKey=${fileKey}, nodeId=${nodeId || '未提供'}, depth=${depth || '默认'}`);
        try {
          Logger.log(
            `获取 ${
              depth ? `${depth} 层深度` : "所有层"
            } 的 ${nodeId ? `节点 ${nodeId} 从文件` : `完整文件`} ${fileKey}`,
          );

          // 为当前请求创建新的FigmaService实例
          Logger.debug("获取 FigmaService 实例...");
          const figmaService = this.getFigmaService();
          Logger.debug("FigmaService 实例已获取");
          
          let file: SimplifiedDesign;
          if (nodeId) {
            Logger.log(`调用 figmaService.getNode: fileKey=${fileKey}, nodeId=${nodeId}, depth=${depth || '默认'}`);
            file = await figmaService.getNode(fileKey, nodeId, depth);
          } else {
            Logger.log(`调用 figmaService.getFile: fileKey=${fileKey}, depth=${depth || '默认'}`);
            file = await figmaService.getFile(fileKey, depth);
          }

          Logger.log(`成功获取文件: ${file.name}`);
          const { nodes, globalVars, ...metadata } = file;

          // Stringify each node individually to try to avoid max string length error with big files
          Logger.debug("准备序列化节点数据...");
          const nodesJson = `[${nodes.map((node) => JSON.stringify(node, null, 2)).join(",")}]`;
          const metadataJson = JSON.stringify(metadata, null, 2);
          const globalVarsJson = JSON.stringify(globalVars, null, 2);
          const resultJson = `{ "metadata": ${metadataJson}, "nodes": ${nodesJson}, "globalVars": ${globalVarsJson} }`;
          Logger.debug("序列化完成");
          Logger.debug(resultJson);
          return {
            content: [{ type: "text", text: resultJson }],
          };
        } catch (error) {
          Logger.error(`Error fetching file ${fileKey}:`, error);
          return {
            content: [{ type: "text", text: `Error fetching file: ${error}` }],
          };
        }
      },
    );

    this.server.tool(
      "get_figma_image_urls",
      "Get URLs for Figma nodes as images (PNG or SVG). Works with any node type - Figma can render any node as an image. Download to use in your own projects.",
      {
        fileKey: z.string().describe("The key of the Figma file containing the node"),
        nodes: z
          .object({
            nodeId: z
              .string()
              .describe("The ID of the Figma node to fetch as image, formatted as 1234:5678"),
            imageRef: z
              .string()
              .optional()
              .describe(
                "If a node has an imageRef fill, you must include this variable. Leave blank for rendering nodes as images.",
              ),
            format: z
              .enum(["png", "svg", "jpg", "pdf"])
              .optional()
              .default("png")
              .describe("The format of the image to fetch. Defaults to png. SVG only works with vector nodes."),
            scale: z
              .number()
              .optional()
              .default(1)
              .describe("The scale to render the image at. Defaults to 1."),
          })
          .array()
          .describe("The nodes to fetch as images"),
      },
      async ({ fileKey, nodes }) => {
        try {
          Logger.log(`Getting image URLs for ${nodes.length} nodes in file ${fileKey}`);
          // 为当前请求创建新的FigmaService实例
          const figmaService = this.getFigmaService();
          
          // 处理有 imageRef 的节点 (图片填充)
          const imageFills = nodes.filter(({ imageRef }) => !!imageRef);
          let imageUrls: Record<string, string> = {};
          
          if (imageFills.length > 0) {
            Logger.debug(`Getting image fill URLs for ${imageFills.length} nodes`);
            const endpoint = `/files/${fileKey}/images`;
            const imageFillResponse = await figmaService.request<GetImageFillsResponse>(endpoint);
            const { images = {} } = imageFillResponse.meta;
            
            for (const node of imageFills) {
              if (node.imageRef && images[node.imageRef]) {
                imageUrls[node.nodeId] = images[node.imageRef];
              }
            }
            Logger.log(`Got ${Object.keys(imageUrls).length} image fill URLs`);
          }
          
          // 处理其他节点 (渲染为图片)
          const renderNodes = nodes.filter(({ imageRef }) => !imageRef);
          if (renderNodes.length > 0) {
            Logger.debug(`Getting image render URLs for ${renderNodes.length} nodes`);
            
            // 按格式和缩放比例分组处理
            const formatGroups: Record<string, any[]> = {};
            
            for (const node of renderNodes) {
              const format = node.format || "png";
              const scale = node.scale || 1;
              const key = `${format}_${scale}`;
              
              if (!formatGroups[key]) {
                formatGroups[key] = [];
              }
              formatGroups[key].push(node);
            }
            
            // 对每个格式和缩放比例组发起请求
            for (const [key, groupNodes] of Object.entries(formatGroups)) {
              const [format, scaleStr] = key.split('_');
              const scale = parseFloat(scaleStr);
              const nodeIds = groupNodes.map(n => n.nodeId);
              
              Logger.debug(`Requesting ${format} images at scale ${scale} for ${nodeIds.length} nodes`);
              const endpoint = `/images/${fileKey}?ids=${nodeIds.join(",")}&format=${format}&scale=${scale}`;
              
              const response = await figmaService.request<GetImagesResponse>(endpoint);
              if (response.images) {
                Object.assign(imageUrls, response.images);
              }
            }
            
            Logger.log(`Got total of ${Object.keys(imageUrls).length} image URLs`);
          }
          
          // 构建结果
          const nodeResults = nodes.map(node => {
            const url = imageUrls[node.nodeId];
            return {
              nodeId: node.nodeId,
              url: url || null,
              success: !!url
            };
          });
          
          const successCount = nodeResults.filter(n => n.success).length;
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: successCount === nodes.length,
                  total: nodes.length,
                  successCount,
                  images: nodeResults
                }, null, 2)
              },
            ],
          };
        } catch (error) {
          Logger.error(`Error getting image URLs from file ${fileKey}:`, error);
          return {
            content: [{ type: "text", text: `Error getting image URLs: ${error}` }],
          };
        }
      },
    );
  }

  async connect(transport: Transport): Promise<void> {
    Logger.log("连接到传输层...");
    try {
      await this.server.connect(transport);
      Logger.log("传输层连接成功");

      Logger.log = (...args: any[]) => {
        console.log(`[${new Date().toISOString()}] [INFO]`, ...args);
        this.server.server.sendLoggingMessage({
          level: "info",
          data: args,
        });
      };
      Logger.error = (...args: any[]) => {
        console.error(`[${new Date().toISOString()}] [ERROR]`, ...args);
        this.server.server.sendLoggingMessage({
          level: "error",
          data: args,
        });
      };

      Logger.log("服务器已连接，准备处理请求");
    } catch (error) {
      Logger.error("连接到传输层失败:", error);
      throw error;
    }
  }

  async startHttpServer(port: number): Promise<void> {
    Logger.log(`启动 HTTP 服务器 (端口: ${port})...`);
    const app = express();
    
    app.get("/sse", async (req: express.Request, res: express.Response) => {
      const requestId = Math.random().toString(36).substring(2, 9);
      Logger.log(`[${requestId}] 新的 SSE 连接建立`);
      
      // Check for API key in query parameters
      const apiKey = req.query.key as string;
      Logger.debug(`[${requestId}] 客户端 IP: ${req.socket?.remoteAddress || '未知'}, User-Agent: ${req.headers['user-agent'] || '未知'}`);
      
      if (apiKey) {
        Logger.log(`[${requestId}] 从查询参数更新 API 密钥`);
        this.updateApiKey(apiKey);
      } else if (this.apiKeyRequired) {
        Logger.warn(`[${requestId}] 未提供必需的 Figma API 密钥`);
        res.status(400).send("Figma API key is required. Use /sse?key=your_figma_api_key");
        return;
      }
      
      Logger.log(`[${requestId}] 创建 SSE 传输层...`);
      try {
        this.sseTransport = new SSEServerTransport(
          "/messages",
          res as unknown as ServerResponse<IncomingMessage>,
        );
        Logger.log(`[${requestId}] SSE 传输层创建成功，连接到服务器...`);
        await this.server.connect(this.sseTransport);
        Logger.log(`[${requestId}] 服务器已连接到 SSE 传输层`);
      } catch (error) {
        Logger.error(`[${requestId}] 连接 SSE 传输层失败:`, error);
        if (!res.headersSent) {
          res.status(500).send("Internal server error");
        }
      }
    });

    app.post("/messages", async (req: express.Request, res: express.Response) => {
      const requestId = Math.random().toString(36).substring(2, 9);
      Logger.log(`[${requestId}] 收到 POST 消息请求`);
      
      if (!this.sseTransport) {
        Logger.warn(`[${requestId}] 没有活动的 SSE 连接`);
        res.sendStatus(400);
        return;
      }
      
      // Check for API key in query parameters
      const apiKey = req.query.key as string;
      if (apiKey) {
        Logger.log(`[${requestId}] 从消息请求更新 API 密钥`);
        this.updateApiKey(apiKey);
      }
      
      Logger.log(`[${requestId}] 处理 POST 消息...`);
      try {
        await this.sseTransport.handlePostMessage(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse<IncomingMessage>,
        );
        Logger.log(`[${requestId}] POST 消息处理完成`);
      } catch (error) {
        Logger.error(`[${requestId}] 处理 POST 消息失败:`, error);
        if (!res.headersSent) {
          res.status(500).send("Internal server error");
        }
      }
    });

    Logger.log = (...args: any[]) => {
      console.log(`[${new Date().toISOString()}] [INFO]`, ...args);
    };
    Logger.error = (...args: any[]) => {
      console.error(`[${new Date().toISOString()}] [ERROR]`, ...args);
    };
    Logger.debug = (...args: any[]) => {
      console.debug(`[${new Date().toISOString()}] [DEBUG]`, ...args);
    };
    Logger.warn = (...args: any[]) => {
      console.warn(`[${new Date().toISOString()}] [WARN]`, ...args);
    };

    try {
      app.listen(port, () => {
        Logger.log(`HTTP 服务器监听端口 ${port}`);
        Logger.log(`SSE 端点可用于: http://localhost:${port}/sse`);
        Logger.log(`消息端点可用于: http://localhost:${port}/messages`);
      });
    } catch (error) {
      Logger.error(`启动 HTTP 服务器失败:`, error);
      throw error;
    }
  }
}
