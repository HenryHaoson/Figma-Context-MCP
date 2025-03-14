import axios, { AxiosError } from "axios";
import fs from "fs";
import { parseFigmaResponse, SimplifiedDesign } from "./simplify-node-response";
import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
} from "@figma/rest-api-spec";
import { downloadFigmaImage } from "~/utils/common";
import { partition } from "remeda";
import { Logger } from "~/server";

export interface FigmaError {
  status: number;
  err: string;
}

type FetchImageParams = {
  /**
   * The Node in Figma that will either be rendered or have its background image downloaded
   */
  nodeId: string;
  /**
   * The local file name to save the image
   */
  fileName: string;
  /**
   * The file mimetype for the image
   */
  fileType: "png" | "svg";
};

type FetchImageFillParams = Omit<FetchImageParams, "fileType"> & {
  /**
   * Required to grab the background image when an image is used as a fill
   */
  imageRef: string;
};

export class FigmaService {
  private apiKey: string;
  private readonly baseUrl = "https://api.figma.com/v1";
  private readonly requestTimeoutMs = 30000; // 30秒超时

  constructor(apiKey: string) {
    Logger.debug("创建 FigmaService 实例");
    this.apiKey = apiKey;
    Logger.debug(`FigmaService 实例化完成，API密钥: ${this.getApiKey()}`);
  }

  /**
   * Updates the Figma API key used for requests
   * @param apiKey - The new Figma API key
   */
  updateApiKey(apiKey: string): void {
    Logger.log(`更新 Figma API 密钥: ${apiKey ? '****' + apiKey.slice(-4) : '未提供'}`);
    this.apiKey = apiKey;
  }

  /**
   * Gets the current API key (masked for security)
   */
  getApiKey(): string {
    if (this.apiKey.length <= 4) return "****";
    return `****${this.apiKey.slice(-4)}`;
  }

  async request<T>(endpoint: string): Promise<T> {
    const requestId = Math.random().toString(36).substring(2, 9);
    const url = `${this.baseUrl}${endpoint}`;
    
    Logger.log(`[${requestId}] 发起 Figma API 请求: ${url}`);
    const startTime = Date.now();
    
    try {
      Logger.debug(`[${requestId}] 请求头信息: { "X-Figma-Token": "${this.getApiKey()}" }`);
      
      const response = await axios.get(url, {
        headers: {
          "X-Figma-Token": this.apiKey,
        },
        timeout: this.requestTimeoutMs,
      });
      
      const duration = Date.now() - startTime;
      Logger.log(`[${requestId}] Figma API 请求成功，耗时: ${duration}ms`);
      Logger.debug(`[${requestId}] 响应状态码: ${response.status}`);
      
      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;
      Logger.error(`[${requestId}] Figma API 请求失败，耗时: ${duration}ms`);
      
      if (error instanceof AxiosError) {
        if (error.code === 'ECONNABORTED') {
          Logger.error(`[${requestId}] 请求超时 (>${this.requestTimeoutMs}ms)`);
        } else if (error.response) {
          Logger.error(`[${requestId}] 服务器响应错误 - 状态码: ${error.response.status}`);
          Logger.error(`[${requestId}] 错误详情:`, error.response.data);
          
          throw {
            status: error.response.status,
            err: (error.response.data as { err?: string }).err || "未知错误",
          } as FigmaError;
        } else if (error.request) {
          Logger.error(`[${requestId}] 未收到响应，可能是网络问题`);
          throw new Error(`未收到响应: ${error.message}`);
        }
      }
      
      Logger.error(`[${requestId}] 完整错误信息:`, error);
      throw new Error(`Figma API 请求失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async getImageFills(
    fileKey: string,
    nodes: FetchImageFillParams[],
    localPath: string,
  ): Promise<string[]> {
    if (nodes.length === 0) return [];
    
    Logger.log(`获取图像填充: fileKey=${fileKey}, 节点数量=${nodes.length}`);
    
    let promises: Promise<string>[] = [];
    try {
      const endpoint = `/files/${fileKey}/images`;
      Logger.debug(`调用 API 获取图像填充数据`);
      const file = await this.request<GetImageFillsResponse>(endpoint);
      const { images = {} } = file.meta;
      
      Logger.log(`已获取图像填充数据，处理 ${Object.keys(images).length} 个图像`);
      
      promises = nodes.map(async ({ imageRef, fileName }) => {
        const imageUrl = images[imageRef];
        if (!imageUrl) {
          Logger.warn(`未找到图像引用 "${imageRef}" 的URL`);
          return ""; // Skip if image URL not found
        }
        
        try {
          Logger.debug(`下载图像: ${imageUrl} -> ${fileName}`);
          await downloadFigmaImage(fileName, localPath, imageUrl);
          Logger.debug(`图像下载成功: ${fileName}`);
          return fileName;
        } catch (error) {
          Logger.error(`下载图像失败 (${imageRef}):`, error);
          return "";
        }
      });
      
      const results = await Promise.all(promises);
      Logger.log(`图像填充处理完成，共 ${results.filter(Boolean).length}/${nodes.length} 个成功`);
      return results.filter(Boolean);
    } catch (error) {
      Logger.error(`获取图像填充失败:`, error);
      throw error;
    }
  }

  async getImages(
    fileKey: string,
    nodes: FetchImageParams[],
    localPath: string,
  ): Promise<string[]> {
    if (nodes.length === 0) return [];

    Logger.log(`获取图像: fileKey=${fileKey}, 节点数量=${nodes.length}`);
    
    try {
      const [svgNodes, pngNodes] = partition(nodes, (node) => node.fileType === "svg");
      let fileNames: string[] = [];

      // Handle SVG nodes
      if (svgNodes.length > 0) {
        Logger.debug(`处理 ${svgNodes.length} 个 SVG 节点`);
        const svgIds = svgNodes.map((node) => node.nodeId);
        const endpoint = `/images/${fileKey}?ids=${svgIds.join(",")}&format=svg`;
        
        const result = await this.request<GetImagesResponse>(endpoint);
        if (!result?.images) {
          Logger.warn(`SVG 图像响应中没有图像数据`);
        } else {
          Logger.debug(`收到 ${Object.keys(result.images).length} 个 SVG 图像URL`);
          
          const svgPromises = svgNodes.map(async ({ nodeId, fileName }) => {
            const imageUrl = result.images[nodeId];
            if (!imageUrl) {
              Logger.warn(`未找到节点 "${nodeId}" 的 SVG 图像 URL`);
              return "";
            }
            
            try {
              Logger.debug(`下载 SVG: ${imageUrl} -> ${fileName}`);
              await downloadFigmaImage(fileName, localPath, imageUrl);
              Logger.debug(`SVG 下载成功: ${fileName}`);
              return fileName;
            } catch (error) {
              Logger.error(`下载 SVG 图像失败 (${nodeId}):`, error);
              return "";
            }
          });
          
          const svgResults = await Promise.all(svgPromises);
          fileNames = [...fileNames, ...svgResults.filter(Boolean)];
          Logger.log(`SVG 图像处理完成，共 ${svgResults.filter(Boolean).length}/${svgNodes.length} 个成功`);
        }
      }

      // Handle PNG nodes
      if (pngNodes.length > 0) {
        Logger.debug(`处理 ${pngNodes.length} 个 PNG 节点`);
        const pngIds = pngNodes.map((node) => node.nodeId);
        const endpoint = `/images/${fileKey}?ids=${pngIds.join(",")}&format=png`;
        
        const result = await this.request<GetImagesResponse>(endpoint);
        if (!result?.images) {
          Logger.warn(`PNG 图像响应中没有图像数据`);
        } else {
          Logger.debug(`收到 ${Object.keys(result.images).length} 个 PNG 图像URL`);
          
          const pngPromises = pngNodes.map(async ({ nodeId, fileName }) => {
            const imageUrl = result.images[nodeId];
            if (!imageUrl) {
              Logger.warn(`未找到节点 "${nodeId}" 的 PNG 图像 URL`);
              return "";
            }
            
            try {
              Logger.debug(`下载 PNG: ${imageUrl} -> ${fileName}`);
              await downloadFigmaImage(fileName, localPath, imageUrl);
              Logger.debug(`PNG 下载成功: ${fileName}`);
              return fileName;
            } catch (error) {
              Logger.error(`下载 PNG 图像失败 (${nodeId}):`, error);
              return "";
            }
          });
          
          const pngResults = await Promise.all(pngPromises);
          fileNames = [...fileNames, ...pngResults.filter(Boolean)];
          Logger.log(`PNG 图像处理完成，共 ${pngResults.filter(Boolean).length}/${pngNodes.length} 个成功`);
        }
      }

      Logger.log(`图像获取完成，共 ${fileNames.length}/${nodes.length} 个成功`);
      return fileNames;
    } catch (error) {
      Logger.error(`获取图像失败:`, error);
      throw error;
    }
  }

  async getFile(fileKey: string, depth?: number): Promise<SimplifiedDesign> {
    const requestId = Math.random().toString(36).substring(2, 9);
    Logger.log(`[${requestId}] 获取 Figma 文件: fileKey=${fileKey}, depth=${depth ?? '默认'}`);
    
    try {
      const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
      const startTime = Date.now();
      
      Logger.debug(`[${requestId}] 发起获取文件请求`);
      const response = await this.request<GetFileResponse>(endpoint);
      
      Logger.log(`[${requestId}] 文件响应成功，开始解析数据...`);
      const parseStartTime = Date.now();
      const simplifiedResponse = parseFigmaResponse(response);
      const parseTime = Date.now() - parseStartTime;
      
      Logger.log(`[${requestId}] 文件数据解析完成，耗时: ${parseTime}ms`);
      Logger.debug(`[${requestId}] 解析后节点数量: ${simplifiedResponse.nodes.length}`);
      
      const totalDuration = Date.now() - startTime;
      Logger.log(`[${requestId}] 文件获取和解析总耗时: ${totalDuration}ms`);
      
      if (process.env.NODE_ENV === "development") {
        Logger.debug(`[${requestId}] 写入调试日志文件`);
        writeLogs("figma-raw.json", response);
        writeLogs("figma-simplified.json", simplifiedResponse);
      }
      
      return simplifiedResponse;
    } catch (e) {
      Logger.error(`[${requestId}] 获取文件失败:`, e);
      throw e;
    }
  }

  async getNode(fileKey: string, nodeId: string, depth?: number): Promise<SimplifiedDesign> {
    const requestId = Math.random().toString(36).substring(2, 9);
    Logger.log(`[${requestId}] 获取 Figma 节点: fileKey=${fileKey}, nodeId=${nodeId}, depth=${depth ?? '默认'}`);
    
    try {
      const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${depth ? `&depth=${depth}` : ""}`;
      const startTime = Date.now();
      
      Logger.debug(`[${requestId}] 发起获取节点请求`);
      const response = await this.request<GetFileNodesResponse>(endpoint);
      
      Logger.log(`[${requestId}] 节点响应成功，开始解析数据...`);
      const parseStartTime = Date.now();
      const simplifiedResponse = parseFigmaResponse(response);
      const parseTime = Date.now() - parseStartTime;
      
      Logger.log(`[${requestId}] 节点数据解析完成，耗时: ${parseTime}ms`);
      Logger.debug(`[${requestId}] 解析后节点数量: ${simplifiedResponse.nodes.length}`);
      
      const totalDuration = Date.now() - startTime;
      Logger.log(`[${requestId}] 节点获取和解析总耗时: ${totalDuration}ms`);
      
      if (process.env.NODE_ENV === "development") {
        Logger.debug(`[${requestId}] 写入调试日志文件`);
        writeLogs("figma-raw.json", response);
        writeLogs("figma-simplified.json", simplifiedResponse);
      }
      
      return simplifiedResponse;
    } catch (e) {
      Logger.error(`[${requestId}] 获取节点失败:`, e);
      throw e;
    }
  }
}

function writeLogs(name: string, value: any) {
  const requestId = Math.random().toString(36).substring(2, 9);
  try {
    if (process.env.NODE_ENV !== "development") return;

    const logsDir = "logs";
    Logger.debug(`[${requestId}] 写入日志到文件: ${name}`);

    try {
      fs.accessSync(process.cwd(), fs.constants.W_OK);
    } catch (error) {
      Logger.error(`[${requestId}] 无法写入日志，没有写入权限:`, error);
      return;
    }

    if (!fs.existsSync(logsDir)) {
      Logger.debug(`[${requestId}] 创建日志目录: ${logsDir}`);
      fs.mkdirSync(logsDir);
    }
    
    const filePath = `${logsDir}/${name}`;
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    Logger.debug(`[${requestId}] 日志写入成功: ${filePath}`);
  } catch (error) {
    Logger.error(`[${requestId}] 写入日志失败:`, error);
  }
}
