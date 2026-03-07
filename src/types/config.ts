/**
 * WSClient 配置相关类型定义
 */

import type { Logger } from './common';

/** WSClient 配置选项 */
export interface WSClientOptions {
  /** 机器人 ID（在企业微信后台获取） */
  botId: string;
  /** 机器人 Secret（在企业微信后台获取） */
  secret: string;
  /** WebSocket 重连基础延迟（毫秒），实际延迟按指数退避递增，默认 1000 */
  reconnectInterval?: number;
  /** 最大重连次数，默认 10，设为 -1 表示无限重连 */
  maxReconnectAttempts?: number;
  /** 心跳间隔（毫秒），默认 30000 */
  heartbeatInterval?: number;
  /** 请求超时时间（毫秒），默认 10000 */
  requestTimeout?: number;
  /** 自定义 WebSocket 连接地址，默认 wss://openws.work.weixin.qq.com */
  wsUrl?: string;
  /** 自定义日志函数 */
  logger?: Logger;
}
