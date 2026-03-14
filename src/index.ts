import { WSClient } from './client';

/** 默认导出 AiBot 命名空间 */
const AiBot = {
  WSClient,
};

export default AiBot;

// 同时支持具名导出
export { WSClient } from './client';
export { WeComApiClient } from './api';
export { WsConnectionManager } from './ws';
export { MessageHandler } from './message-handler';
export { decryptFile } from './crypto';
export { DefaultLogger } from './logger';
export { generateReqId, generateRandomString } from './utils';
export {
  MessageType,
  EventType,
  TemplateCardType,
  WsCmd,
  type WSClientOptions,
  type WSClientEventMap,
  type BaseMessage,
  type TextMessage,
  type ImageMessage,
  type MixedMessage,
  type VoiceMessage,
  type FileMessage,
  type MessageFrom,
  type TextContent,
  type ImageContent,
  type MixedContent,
  type MixedMsgItem,
  type VoiceContent,
  type FileContent,
  type QuoteContent,
  type ReplyOptions,
  type SendTextParams,
  type SendMarkdownParams,
  type WsFrame,
  type WsFrameHeaders,
  type StreamReplyBody,
  type ReplyMsgItem,
  type ReplyFeedback,
  type WelcomeTextReplyBody,
  type WelcomeTemplateCardReplyBody,
  type WelcomeReplyBody,
  type TemplateCardMainTitle,
  type TemplateCardButton,
  type TemplateCardSource,
  type TemplateCardActionMenu,
  type TemplateCardEmphasisContent,
  type TemplateCardQuoteArea,
  type TemplateCardHorizontalContent,
  type TemplateCardJumpAction,
  type TemplateCardAction,
  type TemplateCardVerticalContent,
  type TemplateCardImage,
  type TemplateCardImageTextArea,
  type TemplateCardSubmitButton,
  type TemplateCardSelectionItem,
  type TemplateCardCheckbox,
  type TemplateCard,
  type TemplateCardReplyBody,
  type StreamWithTemplateCardReplyBody,
  type UpdateTemplateCardBody,
  type SendMarkdownMsgBody,
  type SendTemplateCardMsgBody,
  type SendMsgBody,
  type SendMediaMsgBody,
  type WeComMediaType,
  type UploadMediaOptions,
  type UploadMediaInitBody,
  type UploadMediaInitResult,
  type UploadMediaChunkBody,
  type UploadMediaFinishBody,
  type UploadMediaFinishResult,
  type EventFrom,
  type EnterChatEvent,
  type TemplateCardEventData,
  type FeedbackEventData,
  type EventContent,
  type EventMessage,
  type EventMessageWith,
  type Logger,
} from './types';
