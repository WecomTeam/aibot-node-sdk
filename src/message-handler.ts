import type {
  BaseMessage,
  WsFrame,
  Logger,
  WSClientEventMap,
} from './types';
import { MessageType, WsCmd } from './types';
import type { EventMessage } from './types';
import type { WSClient } from './client';

/**
 * 消息处理器
 * 负责解析 WebSocket 帧并分发为具体的消息事件和事件回调
 */
export class MessageHandler {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * 处理收到的 WebSocket 帧，解析并触发对应的消息/事件
   *
   * WebSocket 推送帧结构：
   * - 消息推送：{ cmd: "aibot_msg_callback", headers: { req_id: "xxx" }, body: { msgid, msgtype, ... } }
   * - 事件推送：{ cmd: "aibot_event_callback", headers: { req_id: "xxx" }, body: { msgid, msgtype: "event", event: { ... } } }
   *
   * @param frame - WebSocket 接收帧
   * @param emitter - WSClient 实例，用于触发事件
   */
  handleFrame(frame: WsFrame, emitter: WSClient): void {
    try {
      const body = frame.body;

      if (!body || !body.msgtype) {
        this.logger.warn('Received invalid message format:', JSON.stringify(frame).substring(0, 200));
        return;
      }

      // 事件推送回调处理
      if (frame.cmd === WsCmd.EVENT_CALLBACK) {
        this.handleEventCallback(frame, emitter);
        return;
      }

      // 消息推送回调处理
      this.handleMessageCallback(frame, emitter);
    } catch (error: any) {
      this.logger.error('Failed to handle message:', error.message);
    }
  }

  /**
   * 处理消息推送回调 (aibot_msg_callback)
   */
  private handleMessageCallback(frame: WsFrame, emitter: WSClient): void {
    const body = frame.body as BaseMessage;

    // 触发通用消息事件
    emitter.emit('message', frame);

    // 根据 body 中的消息类型触发特定事件
    switch (body.msgtype) {
      case MessageType.Text:
        emitter.emit('message.text', frame);
        break;
      case MessageType.Image:
        emitter.emit('message.image', frame);
        break;
      case MessageType.Mixed:
        emitter.emit('message.mixed', frame);
        break;
      case MessageType.Voice:
        emitter.emit('message.voice', frame);
        break;
      case MessageType.File:
        emitter.emit('message.file', frame);
        break;
      default:
        this.logger.debug(`Received unhandled message type: ${body.msgtype}`);
        break;
    }
  }

  /**
   * 处理事件推送回调 (aibot_event_callback)
   */
  private handleEventCallback(frame: WsFrame, emitter: WSClient): void {
    const body = frame.body as EventMessage;

    // 触发通用事件
    emitter.emit('event', frame);

    // 根据事件类型触发特定事件
    const eventType = body.event?.eventtype;
    if (eventType) {
      const eventKey = `event.${eventType}` as keyof WSClientEventMap;
      emitter.emit(eventKey, frame);
    } else {
      this.logger.debug('Received event callback without eventtype:', JSON.stringify(body).substring(0, 200));
    }
  }
}
