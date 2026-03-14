import { EventEmitter } from 'eventemitter3';
import type {
  WSClientOptions,
  WSClientEventMap,
  WsFrame,
  WsFrameHeaders,
  StreamReplyBody,
  ReplyMsgItem,
  ReplyFeedback,
  WelcomeTextReplyBody,
  WelcomeTemplateCardReplyBody,
  UpdateTemplateCardBody,
  TemplateCard,
  TemplateCardReplyBody,
  StreamWithTemplateCardReplyBody,
  SendMarkdownMsgBody,
  SendTemplateCardMsgBody,
  SendMediaMsgBody,
  SendMsgBody,
  WeComMediaType,
  UploadMediaOptions,
  UploadMediaFinishResult,
} from './types';
import { WsCmd } from './types';
import { createHash } from 'crypto';
import type { Logger } from './types';
import { WeComApiClient } from './api';
import { WsConnectionManager } from './ws';
import { MessageHandler } from './message-handler';
import { decryptFile } from './crypto';
import { DefaultLogger } from './logger';
import { generateReqId } from './utils';

export class WSClient extends EventEmitter<WSClientEventMap> {
  private options: Required<WSClientOptions>;
  private apiClient: WeComApiClient;
  private wsManager: WsConnectionManager;
  private messageHandler: MessageHandler;
  private logger: Logger;
  private started: boolean = false;

  constructor(options: WSClientOptions) {
    super();

    // 合并默认选项
    this.options = {
      reconnectInterval: 1000,
      maxReconnectAttempts: 10,
      heartbeatInterval: 30000,
      requestTimeout: 10000,
      wsUrl: '',
      logger: new DefaultLogger(),
      ...options,
    } as Required<WSClientOptions>;

    this.logger = this.options.logger;

    // 初始化 API 客户端（仅用于文件下载）
    this.apiClient = new WeComApiClient(
      this.logger,
      this.options.requestTimeout,
    );

    // 初始化 WebSocket 管理器
    this.wsManager = new WsConnectionManager(
      this.logger,
      this.options.heartbeatInterval,
      this.options.reconnectInterval,
      this.options.maxReconnectAttempts,
      this.options.wsUrl || undefined,
    );

    // 设置认证凭证
    this.wsManager.setCredentials(this.options.botId, this.options.secret);

    // 初始化消息处理器
    this.messageHandler = new MessageHandler(this.logger);

    // 绑定 WebSocket 事件
    this.setupWsEvents();
  }

  /**
   * 设置 WebSocket 事件处理
   */
  private setupWsEvents(): void {
    this.wsManager.onConnected = () => {
      this.emit('connected');
    };

    // 认证成功
    this.wsManager.onAuthenticated = () => {
      this.logger.info('Authenticated');
      this.emit('authenticated');
    };

    this.wsManager.onDisconnected = (reason: string) => {
      this.emit('disconnected', reason);
    };

    this.wsManager.onReconnecting = (attempt: number) => {
      this.emit('reconnecting', attempt);
    };

    this.wsManager.onError = (error: Error) => {
      this.emit('error', error);
    };

    this.wsManager.onMessage = (frame: WsFrame) => {
      this.messageHandler.handleFrame(frame, this);
    };
  }

  /**
   * 建立 WebSocket 长连接
   * SDK 使用内置默认地址建立连接，连接成功后自动发送认证帧（botId + secret）。
   * 支持链式调用：wsClient.connect().on('message', handler)
   *
   * @returns 返回 this，支持链式调用
   */
  connect(): this {
    if (this.started) {
      this.logger.warn('Client already connected');
      return this;
    }

    this.logger.info('Establishing WebSocket connection...');
    this.started = true;

    // 直接使用内置默认地址建立连接，连接成功后自动认证
    this.wsManager.connect();

    return this;
  }

  /**
   * 断开 WebSocket 连接
   */
  disconnect(): void {
    if (!this.started) {
      this.logger.warn('Client not connected');
      return;
    }

    this.logger.info('Disconnecting...');
    this.started = false;
    this.wsManager.disconnect();
    this.logger.info('Disconnected');
  }

  /**
   * 通过 WebSocket 通道发送回复消息（通用方法）
   *
   * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
   * @param body - 回复消息体
   * @param cmd
   */
  reply(frame: WsFrameHeaders, body: StreamReplyBody | Record<string, any>, cmd?: string): Promise<WsFrame> {
    const reqId = frame.headers?.req_id || '';
    return this.wsManager.sendReply(reqId, body, cmd);
  }

  /**
   * 发送流式文本回复（便捷方法）
   *
   * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
   * @param streamId - 流式消息 ID
   * @param content - 回复内容（支持 Markdown）
   * @param finish - 是否结束流式消息，默认 false
   * @param msgItem - 图文混排项（仅在 finish=true 时有效），用于在结束时附带图片内容
   * @param feedback - 反馈信息（仅在首次回复时设置）
   */
  replyStream(frame: WsFrameHeaders, streamId: string, content: string, finish: boolean = false, msgItem?: ReplyMsgItem[], feedback?: ReplyFeedback): Promise<WsFrame> {
    const stream: StreamReplyBody['stream'] = {
      id: streamId,
      finish,
      content,
    };

    // msg_item 仅在 finish=true 时支持
    if (finish && msgItem && msgItem.length > 0) {
      stream.msg_item = msgItem;
    }

    // feedback 仅在首次回复时设置
    if (feedback) {
      stream.feedback = feedback;
    }

    return this.reply(frame, {
      msgtype: 'stream',
      stream,
    });
  }

  /**
   * 发送欢迎语回复
   *
   * 注意：此方法需要使用对应事件（如 enter_chat）的 req_id 才能调用，
   * 即 frame 参数应来自触发欢迎语的事件帧。
   * 收到事件回调后需在 5 秒内发送回复，超时将无法发送欢迎语。
   *
   * @param frame - 对应事件的 WebSocket 帧（需包含该事件的 req_id）
   * @param body - 欢迎语消息体（支持文本或模板卡片格式）
   */
  replyWelcome(frame: WsFrameHeaders, body: WelcomeTextReplyBody | WelcomeTemplateCardReplyBody): Promise<WsFrame> {
    return this.reply(frame, body, WsCmd.RESPONSE_WELCOME);
  }

  /**
   * 回复模板卡片消息
   *
   * 收到消息回调或进入会话事件后，可使用此方法回复模板卡片消息。
   *
   * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
   * @param templateCard - 模板卡片内容
   * @param feedback - 反馈信息
   */
  replyTemplateCard(frame: WsFrameHeaders, templateCard: TemplateCard, feedback?: ReplyFeedback): Promise<WsFrame> {
    const card = feedback ? { ...templateCard, feedback } : templateCard;
    const body: TemplateCardReplyBody = {
      msgtype: 'template_card',
      template_card: card,
    };
    return this.reply(frame, body);
  }

  /**
   * 发送流式消息 + 模板卡片组合回复
   *
   * 首次回复时必须返回 stream 的 id。
   * template_card 可首次回复，也可在后续回复中发送，但同一个消息只能回复一次。
   *
   * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
   * @param streamId - 流式消息 ID
   * @param content - 回复内容（支持 Markdown）
   * @param finish - 是否结束流式消息，默认 false
   * @param options - 可选项
   * @param options.msgItem - 图文混排项（仅在 finish=true 时有效）
   * @param options.streamFeedback - 流式消息反馈信息（首次回复时设置）
   * @param options.templateCard - 模板卡片内容（同一消息只能回复一次）
   * @param options.cardFeedback - 模板卡片反馈信息
   */
  replyStreamWithCard(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish: boolean = false,
    options?: {
      msgItem?: ReplyMsgItem[];
      streamFeedback?: ReplyFeedback;
      templateCard?: TemplateCard;
      cardFeedback?: ReplyFeedback;
    },
  ): Promise<WsFrame> {
    const stream: StreamReplyBody['stream'] = {
      id: streamId,
      finish,
      content,
    };

    if (finish && options?.msgItem && options.msgItem.length > 0) {
      stream.msg_item = options.msgItem;
    }

    if (options?.streamFeedback) {
      stream.feedback = options.streamFeedback;
    }

    const body: StreamWithTemplateCardReplyBody = {
      msgtype: 'stream_with_template_card',
      stream,
    };

    if (options?.templateCard) {
      body.template_card = options.cardFeedback
        ? { ...options.templateCard, feedback: options.cardFeedback }
        : options.templateCard;
    }

    return this.reply(frame, body);
  }

  /**
   * 更新模板卡片
   *
   * 注意：此方法需要使用对应事件（template_card_event）的 req_id 才能调用，
   * 即 frame 参数应来自触发更新的事件帧。
   * 收到事件回调后需在 5 秒内发送回复，超时将无法更新卡片。
   *
   * @param frame - 对应事件的 WebSocket 帧（需包含该事件的 req_id）
   * @param templateCard - 模板卡片内容（task_id 需跟回调收到的 task_id 一致）
   * @param userids - 要替换模版卡片消息的 userid 列表，若不填则替换所有用户
   */
  updateTemplateCard(frame: WsFrameHeaders, templateCard: TemplateCard, userids?: string[]): Promise<WsFrame> {
    const body: UpdateTemplateCardBody = {
      response_type: 'update_template_card',
      template_card: templateCard,
    };
    if (userids && userids.length > 0) {
      body.userids = userids;
    }
    return this.reply(frame, body, WsCmd.RESPONSE_UPDATE);
  }

  /**
   * 主动发送消息
   *
   * 向指定会话（单聊或群聊）主动推送消息，无需依赖收到的回调帧。
   *
   * @param chatid - 会话 ID，单聊填用户的 userid，群聊填对应群聊的 chatid
   * @param body - 消息体（支持 markdown 或 template_card 格式）
   * @returns Promise，收到回执时 resolve(回执帧)
   *
   * @example
   * ```ts
   * // 发送 markdown 消息
   * await wsClient.sendMessage('CHATID', {
   *   msgtype: 'markdown',
   *   markdown: { content: '这是一条**主动推送**的消息' },
   * });
   *
   * // 发送模板卡片消息
   * await wsClient.sendMessage('CHATID', {
   *   msgtype: 'template_card',
   *   template_card: { card_type: 'text_notice', ... },
   * });
   * ```
   */
  sendMessage(chatid: string, body: SendMsgBody): Promise<WsFrame> {
    const reqId = generateReqId(WsCmd.SEND_MSG);
    const fullBody = {
      chatid,
      ...body,
    };
    return this.wsManager.sendReply(reqId, fullBody, WsCmd.SEND_MSG);
  }

  /**
   * 上传临时素材（三步分片上传）
   *
   * 通过 WebSocket 长连接执行分片上传：init → chunk × N → finish
   * 单个分片不超过 512KB（Base64 编码前），最多 100 个分片。
   *
   * @param fileBuffer - 文件 Buffer
   * @param options - 上传选项（类型、文件名）
   * @returns 上传结果，包含 media_id
   */
  async uploadMedia(fileBuffer: Buffer, options: UploadMediaOptions): Promise<UploadMediaFinishResult> {
    const { type, filename } = options;
    const totalSize = fileBuffer.length;

    // 分片大小：512KB（Base64 编码前）
    const CHUNK_SIZE = 512 * 1024;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

    if (totalChunks > 100) {
      throw new Error(`File too large: ${totalChunks} chunks exceeds maximum of 100 chunks (max ~50MB)`);
    }

    // 计算文件 MD5
    const md5 = createHash('md5').update(fileBuffer).digest('hex');

    this.logger.info(`Uploading media: type=${type}, filename=${filename}, size=${totalSize}, chunks=${totalChunks}`);

    // Step 1: 初始化上传
    const initReqId = generateReqId(WsCmd.UPLOAD_MEDIA_INIT);
    const initResult = await this.wsManager.sendReply(
      initReqId,
      { type, filename, total_size: totalSize, total_chunks: totalChunks, md5 },
      WsCmd.UPLOAD_MEDIA_INIT,
    );

    const uploadId = initResult.body?.upload_id;
    if (!uploadId) {
      throw new Error(`Upload init failed: no upload_id returned. Response: ${JSON.stringify(initResult)}`);
    }

    this.logger.info(`Upload init success: upload_id=${uploadId}`);

    // Step 2: 分片上传（带重试，根据分片数动态调整并发）
    /** 单分片最大重试次数 */
    const MAX_CHUNK_RETRIES = 2;
    /**
     * 动态计算并发数：
     * - 1~4 分片（≤2MB）：全部并发
     * - 5~10 分片（2~5MB）：并发 3
     * - >10 分片（>5MB）：并发 2（企微后端对大量并发 chunk 会返回 system error）
     */
    const MAX_CONCURRENCY = totalChunks <= 4 ? totalChunks : totalChunks <= 10 ? 3 : 2;

    const uploadChunk = async (chunkIndex: number): Promise<void> => {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const chunk = fileBuffer.subarray(start, end);
      const base64Data = chunk.toString('base64');

      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        try {
          const chunkReqId = generateReqId(WsCmd.UPLOAD_MEDIA_CHUNK);
          await this.wsManager.sendReply(
            chunkReqId,
            { upload_id: uploadId, chunk_index: chunkIndex, base64_data: base64Data },
            WsCmd.UPLOAD_MEDIA_CHUNK,
          );
          this.logger.debug(`Uploaded chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} bytes)`);
          return;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_CHUNK_RETRIES) {
            const delay = 500 * (attempt + 1);
            this.logger.warn(
              `Chunk ${chunkIndex} upload failed (attempt ${attempt + 1}/${MAX_CHUNK_RETRIES + 1}), ` +
              `retrying in ${delay}ms... error: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
            );
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      // 所有重试都失败
      const errMsg = lastError instanceof Error
        ? lastError.message
        : JSON.stringify(lastError);
      throw new Error(`Chunk ${chunkIndex} upload failed after ${MAX_CHUNK_RETRIES + 1} attempts: ${errMsg}`);
    };

    this.logger.debug(`Upload concurrency: ${MAX_CONCURRENCY} workers for ${totalChunks} chunks`);

    if (totalChunks <= 1) {
      // 单分片直接上传
      await uploadChunk(0);
    } else {
      // 多分片并发上传：动态并发数
      let nextIndex = 0;
      const errors: Error[] = [];

      const runWorker = async (): Promise<void> => {
        while (nextIndex < totalChunks) {
          const idx = nextIndex++;
          try {
            await uploadChunk(idx);
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
      };

      const workerCount = Math.min(MAX_CONCURRENCY, totalChunks);
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

      if (errors.length > 0) {
        throw new Error(`Upload failed: ${errors.length} chunk(s) failed. First error: ${errors[0].message}`);
      }
    }

    this.logger.info(`All ${totalChunks} chunks uploaded, finishing...`);

    // Step 3: 完成上传
    const finishReqId = generateReqId(WsCmd.UPLOAD_MEDIA_FINISH);
    const finishResult = await this.wsManager.sendReply(
      finishReqId,
      { upload_id: uploadId },
      WsCmd.UPLOAD_MEDIA_FINISH,
    );

    const mediaId = finishResult.body?.media_id;
    if (!mediaId) {
      throw new Error(`Upload finish failed: no media_id returned. Response: ${JSON.stringify(finishResult)}`);
    }

    this.logger.info(`Upload complete: media_id=${mediaId}, type=${finishResult.body?.type}`);

    return {
      type: finishResult.body?.type ?? type,
      media_id: mediaId,
      created_at: finishResult.body?.created_at ?? new Date().toISOString(),
    };
  }

  /**
   * 被动回复媒体消息（便捷方法）
   *
   * 通过 aibot_respond_msg 被动回复通道发送媒体消息（file/image/voice/video）
   *
   * @param frame - 收到的原始 WebSocket 帧，透传 headers.req_id
   * @param mediaType - 媒体类型
   * @param mediaId - 临时素材 media_id
   * @param videoOptions - 视频消息可选参数（仅 mediaType='video' 时生效）
   */
  replyMedia(frame: WsFrameHeaders, mediaType: WeComMediaType, mediaId: string, videoOptions?: { title?: string; description?: string }): Promise<WsFrame> {
    const mediaContent: Record<string, any> = { media_id: mediaId };
    if (mediaType === 'video' && videoOptions) {
      if (videoOptions.title) mediaContent.title = videoOptions.title;
      if (videoOptions.description) mediaContent.description = videoOptions.description;
    }
    const body: SendMediaMsgBody = {
      msgtype: mediaType,
      [mediaType]: mediaContent,
    };
    return this.reply(frame, body);
  }

  /**
   * 主动发送媒体消息（便捷方法）
   *
   * 通过 aibot_send_msg 主动推送通道发送媒体消息
   *
   * @param chatid - 会话 ID
   * @param mediaType - 媒体类型
   * @param mediaId - 临时素材 media_id
   * @param videoOptions - 视频消息可选参数（仅 mediaType='video' 时生效）
   */
  sendMediaMessage(chatid: string, mediaType: WeComMediaType, mediaId: string, videoOptions?: { title?: string; description?: string }): Promise<WsFrame> {
    const mediaContent: Record<string, any> = { media_id: mediaId };
    if (mediaType === 'video' && videoOptions) {
      if (videoOptions.title) mediaContent.title = videoOptions.title;
      if (videoOptions.description) mediaContent.description = videoOptions.description;
    }
    const body: SendMediaMsgBody = {
      msgtype: mediaType,
      [mediaType]: mediaContent,
    };
    return this.sendMessage(chatid, body);
  }

  /**
   * 下载文件并使用 AES 密钥解密
   *
   * @param url - 文件下载地址
   * @param aesKey - AES 解密密钥（Base64 编码），取自消息中 image.aeskey 或 file.aeskey 字段
   * @returns 解密后的文件 Buffer 及文件名
   *
   * @example
   * ```ts
   * // aesKey 来自消息体中的 image.aeskey 或 file.aeskey
   * const { buffer, filename } = await wsClient.downloadFile(imageUrl, body.image?.aeskey);
   * ```
   */
  async downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    this.logger.debug(`[plugin] downloadFile: url=${url}, hasAesKey=${!!aesKey}`);
    this.logger.info('Downloading and decrypting file...');

    try {
      // 下载加密的文件数据
      const { buffer: encryptedBuffer, filename } = await this.apiClient.downloadFileRaw(url);

      // 如果没有提供 aesKey，直接返回原始数据
      if (!aesKey) {
        this.logger.warn('No aesKey provided, returning raw file data');
        return { buffer: encryptedBuffer, filename };
      }

      // 使用独立的解密模块进行 AES-256-CBC 解密
      const decryptedBuffer = decryptFile(encryptedBuffer, aesKey);

      this.logger.info('File downloaded and decrypted successfully');
      return { buffer: decryptedBuffer, filename };
    } catch (error: any) {
      this.logger.error('File download/decrypt failed:', error.message);
      throw error;
    }
  }

  /**
   * 获取当前连接状态
   */
  get isConnected(): boolean {
    return this.wsManager.isConnected;
  }

  /**
   * 获取 API 客户端实例（供高级用途使用，如文件下载）
   */
  get api(): WeComApiClient {
    return this.apiClient;
  }
}
