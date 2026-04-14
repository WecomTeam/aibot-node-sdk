import WebSocket, { type ClientOptions as WsClientOptions } from 'ws';
import { getProxyForUrl } from 'proxy-from-env';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Logger, WsFrame } from './types';
import { WsCmd, WSAuthFailureError, WSReconnectExhaustedError } from './types';
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
  private wsOptions: WsClientOptions;
  private heartbeatInterval: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private maxReconnectAttempts: number;
  private maxAuthFailureAttempts: number;
  private reconnectAttempts: number = 0;
  private authFailureAttempts: number = 0;
  private isManualClose: boolean = false;
  /** 标记最近一次连接关闭是否因认证失败触发（用于 scheduleReconnect 区分重连类型） */
  private lastCloseWasAuthFailure: boolean = false;

  /** 认证凭证 */
  private botId: string = '';
  private botSecret: string = '';
  /** 额外的认证参数（如 scene、plug_version 等），会展开到认证帧 body 中 */
  private extraAuthParams: Record<string, any> = {};

  /** Number of consecutive missed heartbeat acks (pong) */
  private missedPongCount: number = 0;
  /** Max missed pong before treating connection as dead */
  private readonly maxMissedPong: number = 2;
  /** Base delay (ms) for exponential back-off reconnection */
  private reconnectBaseDelay: number = 1000;
  /** Upper cap (ms) for reconnect delay */
  private readonly reconnectMaxDelay: number = 30000;
  /** 重连定时器引用，用于在 disconnect/connect 时取消挂起的重连 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** 按 req_id 分组的回复发送队列，保证同一 req_id 的消息串行发送 */
  private replyQueues: Map<string, ReplyQueueItem[]> = new Map();
  /** 正在等待回执的 req_id 集合，value 包含超时定时器、resolve/reject 和序列号 */
  private pendingAcks: Map<string, {
    resolve: (ackFrame: WsFrame) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
    seq: number;
  }> = new Map();
  /** 自增序列号，用于区分同一 reqId 的不同 pending，防止超时与 ack 竞态 */
  private pendingAckSeq: number = 0;
  /** 回执超时时间（毫秒） */
  private readonly replyAckTimeout: number = 5000;
  /** 单个 req_id 的回复队列最大长度，超过后新消息将被拒绝 */
  private maxReplyQueueSize: number = 500;

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
  /** 服务端主动断开回调（新连接建立导致旧连接被断开） */
  public onServerDisconnect: ((reason: string) => void) | null = null;

  constructor(
    logger: Logger,
    heartbeatInterval: number = 30000,
    reconnectBaseDelay: number = 1000,
    maxReconnectAttempts: number = 10,
    wsUrl?: string,
    wsOptions?: WsClientOptions,
    maxReplyQueueSize?: number,
    maxAuthFailureAttempts?: number,
  ) {
    this.logger = logger;
    this.heartbeatInterval = heartbeatInterval;
    this.reconnectBaseDelay = reconnectBaseDelay;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.maxAuthFailureAttempts = maxAuthFailureAttempts ?? 5;
    this.wsUrl = wsUrl || DEFAULT_WS_URL;
    this.wsOptions = wsOptions || {};
    if (maxReplyQueueSize !== undefined) {
      this.maxReplyQueueSize = maxReplyQueueSize;
    }
  }

  /**
   * 设置认证凭证
   */
  setCredentials(botId: string, botSecret: string, extraAuthParams?: Record<string, any>): void {
    this.botId = botId;
    this.botSecret = botSecret;
    this.extraAuthParams = extraAuthParams || {};
  }

  /**
   * 建立 WebSocket 连接（使用 SDK 内置默认地址）
   */
  connect(): void {
    this.isManualClose = false;

    // 取消挂起的重连定时器，防止与当前 connect 竞态
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 清理可能未完全关闭的旧连接
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }

    this.logger.info(`Connecting to WebSocket: ${this.wsUrl}...`);

    const mergedOptions: WsClientOptions = { ...this.wsOptions };
    // `proxy-from-env` 只对 http/https 做代理判定，直接传 wss/ws 会拿不到代理。
    // 这里把 ws(s) 映射到对应的 http(s) URL 来进行 NO_PROXY/代理匹配。
    const proxyLookupUrl = this.wsUrl
      .replace(/^wss:/i, "https:")
      .replace(/^ws:/i, "http:");
    const proxyUrl = getProxyForUrl(proxyLookupUrl);
    if (proxyUrl && !mergedOptions.agent) {
      mergedOptions.agent = new HttpsProxyAgent(proxyUrl);
    }

    try {
      this.ws = new WebSocket(this.wsUrl, mergedOptions);
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
      // 注意：不在 open 时重置 reconnectAttempts，因为 TCP 连接成功不代表认证会成功。
      // 只有在认证成功后才重置所有计数器（见 handleFrame 中的认证响应处理）。
      this.missedPongCount = 0;
      this.lastCloseWasAuthFailure = false;
      // 连接建立后立即发送认证帧
      this.sendAuth();
      this.onConnected?.();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const raw = data.toString();
        const frame = JSON.parse(raw) as WsFrame;
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
      // 释放旧 WebSocket 实例引用，便于 GC 回收
      this.ws = null;

      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: Error) => {
      this.logger.error('WebSocket error:', error.message);
      this.onError?.(error);
    });

    this.ws.on('ping', () => {
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
          ...this.extraAuthParams,
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
    const cmd = frame.cmd || '';
    const reqId = frame.headers?.req_id || '';

    // 消息推送：cmd 为 "aibot_msg_callback"
    if (frame.cmd === WsCmd.CALLBACK) {
      this.logger.debug(`[server -> plugin] cmd=${cmd}, reqId=${reqId}, body=${JSON.stringify(frame.body)}`);
      this.onMessage?.(frame);
      return;
    }

    // 事件推送：cmd 为 "aibot_event_callback"
    if (frame.cmd === WsCmd.EVENT_CALLBACK) {
      this.logger.debug(`[server -> plugin] cmd=${cmd}, reqId=${reqId}, body=${JSON.stringify(frame.body)}`);

      // 检测 disconnected_event：有新连接建立，服务端通知旧连接即将被断开
      if (frame.body?.event?.eventtype === 'disconnected_event') {
        this.logger.warn('Received disconnected_event: a new connection has been established, this connection will be closed by server');
        // 先分发事件给上层（让用户可以监听 event.disconnected_event）
        this.onMessage?.(frame);
        // 停止心跳、清理待处理消息
        this.stopHeartbeat();
        this.clearPendingMessages('Server disconnected due to new connection');
        // 标记为非手动断开但阻止自动重连（服务端正常行为，重连也会被再次断开）
        this.isManualClose = true;
        // 通知上层服务端主动断开
        this.onServerDisconnect?.('New connection established, server disconnected this connection');
        // 主动关闭 socket，避免连接处于僵尸状态
        if (this.ws) {
          this.ws.removeAllListeners();
          this.ws.terminate();
          this.ws = null;
        }
        return;
      }

      this.onMessage?.(frame);
      return;
    }

    // 无 cmd 的帧：认证响应、心跳响应或回复消息回执，通过 req_id 前缀区分类型，再判断 errcode
    const actualReqId = frame.headers?.req_id || '';

    // 认证响应（优先于 pendingAcks 检查，避免误判）
    if (actualReqId.startsWith(WsCmd.SUBSCRIBE)) {
      if (frame.errcode !== 0) {
        this.logger.error(`Authentication failed: errcode=${frame.errcode}, errmsg=${frame.errmsg}`);
        this.onError?.(new Error(`Authentication failed: ${frame.errmsg} (code: ${frame.errcode})`));
        // 标记为认证失败，close 事件中 scheduleReconnect 会据此使用 authFailureAttempts 计数器
        this.lastCloseWasAuthFailure = true;
        // 认证失败，主动关闭连接，触发 close 事件进而执行 scheduleReconnect 重连逻辑
        if (this.ws) {
          this.ws.terminate();
        }
        return;
      }
      this.logger.info('Authentication successful');
      // 认证成功：重置所有重连计数器
      this.reconnectAttempts = 0;
      this.authFailureAttempts = 0;
      this.startHeartbeat();
      this.onAuthenticated?.();
      return;
    }

    // 心跳响应（优先于 pendingAcks 检查，避免误判）
    if (actualReqId.startsWith(WsCmd.HEARTBEAT)) {
      if (frame.errcode !== 0) {
        this.logger.warn(`Heartbeat ack error: errcode=${frame.errcode}, errmsg=${frame.errmsg}`);
        return;
      }
      this.missedPongCount = 0;
      return;
    }

    // 检查是否是回复消息的回执（req_id 存在于 pendingAcks 中）
    if (this.pendingAcks.has(actualReqId)) {
      this.handleReplyAck(actualReqId, frame);
      return;
    }

    // 未知帧类型 — 只记录警告，不传给 onMessage（避免 body=undefined 导致下游误处理）
    this.logger.warn('Received unknown frame (ignored):', JSON.stringify(frame));
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
    } catch (error: any) {
      this.logger.error('Failed to send heartbeat:', error.message);
    }
  }

  /**
   * 安排重连
   *
   * 区分两种重连场景，使用独立的计数器和最大重试次数：
   * - 认证失败（lastCloseWasAuthFailure=true）：使用 authFailureAttempts / maxAuthFailureAttempts
   * - 连接断开（lastCloseWasAuthFailure=false）：使用 reconnectAttempts / maxReconnectAttempts
   *
   * disconnected_event（被踢下线）不会触发重连，因为 isManualClose 已被设为 true。
   */
  private scheduleReconnect(): void {
    if (this.lastCloseWasAuthFailure) {
      // 认证失败场景
      if (this.maxAuthFailureAttempts !== -1 && this.authFailureAttempts >= this.maxAuthFailureAttempts) {
        this.logger.error(`Max auth failure attempts reached (${this.maxAuthFailureAttempts}), giving up`);
        this.onError?.(new WSAuthFailureError(this.maxAuthFailureAttempts));
        return;
      }
      this.authFailureAttempts++;

      const delay = Math.min(
        this.reconnectBaseDelay * Math.pow(2, this.authFailureAttempts - 1),
        this.reconnectMaxDelay,
      );

      this.logger.info(`Auth failed, reconnecting in ${delay}ms (auth attempt ${this.authFailureAttempts}/${this.maxAuthFailureAttempts})...`);
      this.onReconnecting?.(this.authFailureAttempts);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.isManualClose) return;
        this.connect();
      }, delay);
    } else {
      // 连接断开场景（网络异常、心跳超时等）
      if (this.maxReconnectAttempts !== -1 && this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.logger.error(`Max reconnect attempts reached (${this.maxReconnectAttempts}), giving up`);
        this.onError?.(new WSReconnectExhaustedError(this.maxReconnectAttempts));
        return;
      }
      this.reconnectAttempts++;

      const delay = Math.min(
        this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
        this.reconnectMaxDelay,
      );

      this.logger.info(`Connection lost, reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      this.onReconnecting?.(this.reconnectAttempts);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.isManualClose) return;
        this.connect();
      }, delay);
    }
  }

  /**
   * 发送数据帧
   *
   * 统一格式：{ cmd, headers: { req_id }, body }
   */
  send(frame: WsFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(frame);
      this.ws.send(data);
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
    // // 日志中截断 base64_data，避免分片上传时日志过大
    // const logBody = body?.base64_data
    //   ? { ...body, base64_data: `<${body.base64_data.length} chars>` }
    //   : body;
    // this.logger.debug(`[ws] sendReply: reqId=${reqId}, cmd=${cmd}, body=${JSON.stringify(logBody)}`);
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
      // 发送失败：reject 当前项，用 queueMicrotask 异步继续处理下一条，避免同步递归栈溢出
      queue.shift();
      item.reject(error);
      queueMicrotask(() => this.processReplyQueue(reqId));
      return;
    }

    // 分配唯一序列号，用于超时回调中校验是否是当前 pending
    const seq = ++this.pendingAckSeq;

    // 设置回执超时定时器
    const timer = setTimeout(() => {
      // 校验 seq：如果不匹配，说明这是过期的超时回调（当前 pending 已被正常 ack 处理过），直接忽略
      const currentPending = this.pendingAcks.get(reqId);
      if (!currentPending || currentPending.seq !== seq) {
        return;
      }

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
      seq,
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
    // 收集所有已在 pendingAcks 中的 reject 函数引用，用于后续去重
    const pendingRejects = new Set<(reason: any) => void>();

    // 先清理 pendingAcks：清除定时器并 reject 正在等待回执的消息
    for (const [reqId, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pendingRejects.add(pending.reject);
      pending.reject(new Error(`${reason}, reply for reqId: ${reqId} cancelled`));
    }
    this.pendingAcks.clear();

    // 再清理 replyQueues：跳过已经在 pendingAcks 中被 reject 过的队首 item，避免双重 reject
    for (const [reqId, queue] of this.replyQueues) {
      for (const item of queue) {
        if (pendingRejects.has(item.reject)) {
          continue; // 已在 pendingAcks 中被 reject 过，跳过
        }
        item.reject(new Error(`${reason}, reply for reqId: ${reqId} cancelled`));
      }
    }
    this.replyQueues.clear();
  }

  disconnect(): void {
    this.isManualClose = true;
    this.stopHeartbeat();
    this.clearPendingMessages('Connection manually closed');

    // 取消挂起的重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }

    this.logger.info('WebSocket connection manually closed');
  }

  /**
   * 检查指定 reqId 是否有待回执的消息（即上一条消息还未收到 ack）
   *
   * 用于流式场景：调用方可据此决定是否跳过当前帧，避免排队积压。
   *
   * @param reqId - 要检查的 req_id
   * @returns true 表示有消息正在等待 ack
   */
  hasPendingAck(reqId: string): boolean {
    return this.pendingAcks.has(reqId);
  }

  /**
   * 获取当前连接状态
   */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
