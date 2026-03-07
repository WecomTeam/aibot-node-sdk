import WebSocket from 'ws';
import type { Logger, WsFrame } from './types';
import { WsCmd } from './types';
import { generateReqId } from './utils';

/** SDK 内置默认 WebSocket 连接地址 */
const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com';

/**
 * WebSocket 长连接管理器
 * 负责维护与企业微信的 WebSocket 长连接，包括心跳、重连、认证等
 */
/** 回复队列中的单个任务项 */
interface ReplyQueueItem {
  /** 要发送的帧数据 */
  frame: WsFrame;
  /** 发送成功（收到回执）时的 resolve，传入回执帧 */
  resolve: (ackFrame: WsFrame) => void;
  /** 发送失败（超时/errcode非0）时的 reject，errcode非0时传入回执帧，超时时传入Error */
  reject: (reason: any) => void;
}

export class WsConnectionManager {
  private ws: WebSocket | null = null;
  private logger: Logger;
  private wsUrl: string;
  private heartbeatInterval: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private maxReconnectAttempts: number;
  private reconnectAttempts: number = 0;
  private isManualClose: boolean = false;

  /** 认证凭证 */
  private botId: string = '';
  private botSecret: string = '';

  /** Number of consecutive missed heartbeat acks (pong) */
  private missedPongCount: number = 0;
  /** Max missed pong before treating connection as dead */
  private readonly maxMissedPong: number = 2;
  /** Base delay (ms) for exponential back-off reconnection */
  private reconnectBaseDelay: number = 1000;
  /** Upper cap (ms) for reconnect delay */
  private readonly reconnectMaxDelay: number = 30000;

  /** 按 req_id 分组的回复发送队列，保证同一 req_id 的消息串行发送 */
  private replyQueues: Map<string, ReplyQueueItem[]> = new Map();
  /** 正在等待回执的 req_id 集合，value 包含超时定时器和 resolve/reject */
  private pendingAcks: Map<string, {
    resolve: (ackFrame: WsFrame) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  /** 回执超时时间（毫秒） */
  private readonly replyAckTimeout: number = 5000;
  /** 单个 req_id 的回复队列最大长度，超过后新消息将被拒绝 */
  private readonly maxReplyQueueSize: number = 100;

  /** 连接建立回调（WebSocket open 事件，认证尚未完成） */
  public onConnected: (() => void) | null = null;
  /** 认证成功回调 */
  public onAuthenticated: (() => void) | null = null;
  /** 连接断开回调 */
  public onDisconnected: ((reason: string) => void) | null = null;
  /** 收到消息回调 */
  public onMessage: ((frame: WsFrame) => void) | null = null;
  /** 重连回调 */
  public onReconnecting: ((attempt: number) => void) | null = null;
  /** 错误回调 */
  public onError: ((error: Error) => void) | null = null;

  constructor(
    logger: Logger,
    heartbeatInterval: number = 30000,
    reconnectBaseDelay: number = 1000,
    maxReconnectAttempts: number = 10,
    wsUrl?: string,
  ) {
    this.logger = logger;
    this.heartbeatInterval = heartbeatInterval;
    this.reconnectBaseDelay = reconnectBaseDelay;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.wsUrl = wsUrl || DEFAULT_WS_URL;
  }

  /**
   * 设置认证凭证
   */
  setCredentials(botId: string, botSecret: string): void {
    this.botId = botId;
    this.botSecret = botSecret;
  }

  /**
   * 建立 WebSocket 连接（使用 SDK 内置默认地址）
   */
  connect(): void {
    this.isManualClose = false;

    // 清理可能未完全关闭的旧连接
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }

    this.logger.info(`Connecting to WebSocket: ${this.wsUrl}...`);

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.setupEventHandlers();
    } catch (error: any) {
      this.logger.error('Failed to create WebSocket connection:', error.message);
      this.onError?.(error);
      this.scheduleReconnect();
    }
  }

  /**
   * 设置 WebSocket 事件处理器
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.logger.info('WebSocket connection established, sending auth...');
      this.reconnectAttempts = 0;
      this.missedPongCount = 0;
      // 连接建立后立即发送认证帧
      this.sendAuth();
      this.onConnected?.();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const frame = JSON.parse(data.toString()) as WsFrame;
        this.handleFrame(frame);
      } catch (error: any) {
        this.logger.error('Failed to parse WebSocket message:', error.message);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || `code: ${code}`;
      this.logger.warn(`WebSocket connection closed: ${reasonStr}`);
      this.stopHeartbeat();
      this.clearPendingMessages(`WebSocket connection closed (${reasonStr})`);
      this.onDisconnected?.(reasonStr);

      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: Error) => {
      this.logger.error('WebSocket error:', error.message);
      this.onError?.(error);
    });

    this.ws.on('ping', () => {
      this.logger.debug('Received WebSocket protocol ping, sent pong');
      this.ws?.pong();
    });
  }



  /**
   * 发送认证帧
   *
   * 格式：{ cmd: "aibot_subscribe", headers: { req_id }, body: { secret, bot_id } }
   */
  private sendAuth(): void {
    try {
      this.send({
        cmd: WsCmd.SUBSCRIBE,
        headers: { req_id: generateReqId(WsCmd.SUBSCRIBE) },
        body: {
          bot_id: this.botId,
          secret: this.botSecret,
        },
      });
      this.logger.info('Auth frame sent');
    } catch (error: any) {
      this.logger.error('Failed to send auth frame:', error.message);
    }
  }

  /**
   * 处理收到的帧数据
   *
   * 接收帧结构：
   * - 消息推送：{ cmd: "aibot_msg_callback", headers: { req_id }, body: { ... } }
   * - 认证/心跳响应：{ headers: { req_id }, errcode: 0, errmsg: "ok" }
   */
  private handleFrame(frame: WsFrame): void {
    // 消息推送：cmd 为 "aibot_msg_callback"
    if (frame.cmd === WsCmd.CALLBACK) {
      this.logger.debug('Received push message:', JSON.stringify(frame.body));
      this.onMessage?.(frame);
      return;
    }

    // 事件推送：cmd 为 "aibot_event_callback"
    if (frame.cmd === WsCmd.EVENT_CALLBACK) {
      this.logger.debug('Received event callback:', JSON.stringify(frame.body));
      this.onMessage?.(frame);
      return;
    }

    // 无 cmd 的帧：认证响应、心跳响应或回复消息回执，通过 req_id 前缀区分类型，再判断 errcode
    const reqId = frame.headers?.req_id || '';

    // 检查是否是回复消息的回执（req_id 存在于 pendingAcks 中）
    if (this.pendingAcks.has(reqId)) {
      this.handleReplyAck(reqId, frame);
      return;
    }

    if (reqId.startsWith(WsCmd.SUBSCRIBE)) {
      // 认证响应
      if (frame.errcode !== 0) {
        this.logger.error(`Authentication failed: errcode=${frame.errcode}, errmsg=${frame.errmsg}`);
        this.onError?.(new Error(`Authentication failed: ${frame.errmsg} (code: ${frame.errcode})`));
        return;
      }
      this.logger.info('Authentication successful');
      this.startHeartbeat();
      this.onAuthenticated?.();
      return;
    }

    if (reqId.startsWith(WsCmd.HEARTBEAT)) {
      // 心跳响应
      if (frame.errcode !== 0) {
        this.logger.warn(`Heartbeat ack error: errcode=${frame.errcode}, errmsg=${frame.errmsg}`);
        return;
      }
      this.missedPongCount = 0;
      this.logger.debug('Received heartbeat ack');
      return;
    }

    // 未知帧类型
    this.logger.warn('Received unknown frame:', JSON.stringify(frame));
    this.onMessage?.(frame);
  }

  /**
   * 启动心跳定时器
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatInterval);
    this.logger.debug(`Heartbeat timer started, interval: ${this.heartbeatInterval}ms`);
  }

  /**
   * 停止心跳定时器
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.logger.debug('Heartbeat timer stopped');
    }
  }

  /**
   * 发送心跳
   * If consecutive missed pong count reaches the threshold, treat the
   * connection as dead and trigger reconnection.
   *
   * 格式：{ cmd: "ping", headers: { req_id } }
   */
  private sendHeartbeat(): void {
    // Check missed pong BEFORE sending the next heartbeat
    if (this.missedPongCount >= this.maxMissedPong) {
      this.logger.warn(
        `No heartbeat ack received for ${this.missedPongCount} consecutive pings, connection considered dead`,
      );
      this.stopHeartbeat();
      // Force-close the underlying socket so the 'close' handler fires
      if (this.ws) {
        this.ws.terminate();
      }
      return;
    }

    this.missedPongCount++;
    try {
      this.send({
        cmd: WsCmd.HEARTBEAT,
        headers: { req_id: generateReqId(WsCmd.HEARTBEAT) },
      });
      this.logger.debug(`Heartbeat sent${this.missedPongCount > 1 ? ` (awaiting ${this.missedPongCount} pong)` : ''}`);
    } catch (error: any) {
      this.logger.error('Failed to send heartbeat:', error.message);
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    if (this.maxReconnectAttempts !== -1 && this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`Max reconnect attempts reached (${this.maxReconnectAttempts}), giving up`);
      this.onError?.(new Error('Max reconnect attempts exceeded'));
      return;
    }

    this.reconnectAttempts++;
    // Exponential back-off: 1s, 2s, 4s, 8s … capped at reconnectMaxDelay
    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectMaxDelay,
    );

    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    this.onReconnecting?.(this.reconnectAttempts);

    setTimeout(() => {
      if (this.isManualClose) return;
      // 重连时直接使用内置默认地址，连接建立后自动重新认证
      this.connect();
    }, delay);
  }

  /**
   * 发送数据帧
   *
   * 统一格式：{ cmd, headers: { req_id }, body }
   */
  send(frame: WsFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    } else {
      throw new Error('WebSocket not connected, unable to send data');
    }
  }

  /**
   * 通过 WebSocket 通道发送回复消息（串行队列版本）
   *
   * 同一个 req_id 的消息会被放入队列中串行发送：
   * 发送一条后等待服务端回执，收到回执或超时后才发送下一条。
   *
   * 格式：{ cmd: "aibot_respond_msg", headers: { req_id }, body: { ... } }
   *
   * @param reqId - 透传回调中的 req_id
   * @param body - 回复消息体（如 StreamReplyBody）
   * @param cmd - 发送的命令类型，默认 WsCmd.RESPONSE
   * @returns Promise，收到回执时 resolve(回执帧)，超时或errcode非0时 reject(Error)
   */
  sendReply(reqId: string, body: any, cmd: string = WsCmd.RESPONSE): Promise<WsFrame> {
    return new Promise<WsFrame>((resolve, reject) => {
      const frame: WsFrame = {
        cmd,
        headers: { req_id: reqId },
        body,
      };

      const item: ReplyQueueItem = { frame, resolve, reject };

      // 入队
      if (!this.replyQueues.has(reqId)) {
        this.replyQueues.set(reqId, []);
      }

      const queue = this.replyQueues.get(reqId)!;

      // 防止队列无限增长导致内存泄漏
      if (queue.length >= this.maxReplyQueueSize) {
        this.logger.warn(`Reply queue for reqId ${reqId} exceeds max size (${this.maxReplyQueueSize}), rejecting new message`);
        reject(new Error(`Reply queue for reqId ${reqId} exceeds max size (${this.maxReplyQueueSize})`));
        return;
      }

      queue.push(item);

      // 如果队列中只有这一条，说明当前空闲，立即开始处理
      if (queue.length === 1) {
        this.processReplyQueue(reqId);
      }
    });
  }

  /**
   * 处理指定 req_id 的回复队列
   * 取出队列头部的消息发送，并设置回执超时
   */
  private processReplyQueue(reqId: string): void {
    const queue = this.replyQueues.get(reqId);
    if (!queue || queue.length === 0) {
      // 队列为空，清理
      this.replyQueues.delete(reqId);
      return;
    }

    const item = queue[0];

    try {
      // 发送帧
      this.send(item.frame);
      this.logger.debug(`Reply message sent via WebSocket, reqId: ${reqId}, queue length: ${queue.length}`);
    } catch (error: any) {
      this.logger.error(`Failed to send reply for reqId ${reqId}:`, error.message);
      // 发送失败：reject 当前项，继续处理队列中的下一条
      queue.shift();
      item.reject(error);
      this.processReplyQueue(reqId);
      return;
    }

    // 设置回执超时定时器
    const timer = setTimeout(() => {
      this.logger.warn(`Reply ack timeout (${this.replyAckTimeout}ms) for reqId: ${reqId}`);
      this.pendingAcks.delete(reqId);

      // 超时：reject 当前项，然后继续处理队列中的下一条
      queue.shift();
      item.reject(new Error(`Reply ack timeout (${this.replyAckTimeout}ms) for reqId: ${reqId}`));

      this.processReplyQueue(reqId);
    }, this.replyAckTimeout);

    // 注册到待回执 Map
    this.pendingAcks.set(reqId, {
      resolve: item.resolve,
      reject: item.reject,
      timer,
    });
  }

  /**
   * 处理回复消息的回执
   * 收到回执后释放队列锁，继续处理下一条
   */
  private handleReplyAck(reqId: string, frame: WsFrame): void {
    const pending = this.pendingAcks.get(reqId);
    if (!pending) return;

    // 清除超时定时器
    clearTimeout(pending.timer);
    this.pendingAcks.delete(reqId);

    const queue = this.replyQueues.get(reqId);

    if (frame.errcode !== 0) {
      this.logger.warn(`Reply ack error: reqId=${reqId}, errcode=${frame.errcode}, errmsg=${frame.errmsg}`);
      // 失败：reject 当前项
      if (queue) {
        queue.shift();
      }
      pending.reject(frame);
    } else {
      this.logger.debug(`Reply ack received for reqId: ${reqId}`);
      // 成功：resolve 当前项，传入完整回执帧
      if (queue) {
        queue.shift();
      }
      pending.resolve(frame);
    }

    // 继续处理队列中的下一条
    this.processReplyQueue(reqId);
  }

  /**
   * 主动断开连接
   */
  /**
   * 清理所有待处理的消息和回执
   * @param reason - 清理原因，用于 reject 的错误信息
   */
  private clearPendingMessages(reason: string): void {
    for (const [_reqId, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
    }
    this.pendingAcks.clear();

    for (const [reqId, queue] of this.replyQueues) {
      for (const item of queue) {
        item.reject(new Error(`${reason}, reply for reqId: ${reqId} cancelled`));
      }
    }
    this.replyQueues.clear();
  }

  disconnect(): void {
    this.isManualClose = true;
    this.stopHeartbeat();
    this.clearPendingMessages('Connection manually closed');

    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }

    this.logger.info('WebSocket connection manually closed');
  }

  /**
   * 获取当前连接状态
   */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
