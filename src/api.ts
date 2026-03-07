import axios, { AxiosInstance } from 'axios';
import type { Logger } from './types';

/**
 * 企业微信 API 客户端
 * 仅负责文件下载等 HTTP 辅助功能，消息收发均走 WebSocket 通道
 */
export class WeComApiClient {
  private httpClient: AxiosInstance;
  private logger: Logger;

  constructor(logger: Logger, timeout: number = 10000) {
    this.logger = logger;

    this.httpClient = axios.create({
      timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * 下载文件（返回原始 Buffer 及文件名）
   */
  async downloadFileRaw(url: string): Promise<{ buffer: Buffer; filename?: string }> {
    this.logger.info('Downloading file...');

    try {
      const response = await this.httpClient.get(url, {
        responseType: 'arraybuffer',
      });

      // 从 Content-Disposition 头中解析文件名
      const contentDisposition = response.headers['content-disposition'] as string | undefined;
      let filename: string | undefined;
      if (contentDisposition) {
        // 优先匹配 filename*=UTF-8''xxx 格式（RFC 5987）
        const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;\s]+)/i);
        if (utf8Match) {
          filename = decodeURIComponent(utf8Match[1]);
        } else {
          // 匹配 filename="xxx" 或 filename=xxx 格式
          const match = contentDisposition.match(/filename="?([^";\s]+)"?/i);
          if (match) {
            filename = decodeURIComponent(match[1]);
          }
        }
      }

      this.logger.info('File downloaded successfully');
      return { buffer: Buffer.from(response.data), filename };
    } catch (error: any) {
      this.logger.error('File download failed:', error.message);
      throw error;
    }
  }
}
