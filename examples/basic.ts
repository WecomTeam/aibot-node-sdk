/**
 * 企业微信智能机器人 SDK 基本使用示例
 */
import fs from 'fs';
import path from 'path';
import WecomAiBot from '../src';
import type { WsFrame } from '../src';
import { generateReqId } from '../src';

// 创建 WSClient 实例
const wsClient = new WecomAiBot.WSClient({
  botId: 'your-bot-id',        // 替换为你的机器人 ID
  secret: 'your-bot-secret',   // 替换为你的机器人 Secret
});

const templateCard = {
  "card_type": "multiple_interaction",
  "source": {
    "icon_url": "https://wework.qpic.cn/wwpic/252813_jOfDHtcISzuodLa_1629280209/0",
    "desc": "企业微信"
  },
  "main_title": {
    "title": "欢迎使用企业微信",
    "desc": "您的好友正在邀请您加入企业微信"
  },
  "select_list": [
    {
      "question_key": "question_key_one",
      "title": "选择标签1",
      "disable": false,
      "selected_id": "id_one",
      "option_list": [
        {
          "id": "id_one",
          "text": "选择器选项1"
        },
        {
          "id": "id_two",
          "text": "选择器选项2"
        }
      ]
    },
    {
      "question_key": "question_key_two",
      "title": "选择标签2",
      "selected_id": "id_three",
      "option_list": [
        {
          "id": "id_three",
          "text": "选择器选项3"
        },
        {
          "id": "id_four",
          "text": "选择器选项4"
        }
      ]
    }
  ],
  "submit_button": {
    "text": "提交",
    "key": "submit_key"
  },
  "task_id": `task_id_${Date.now()}`
};

// 建立连接
wsClient.connect();

// 监听连接事件
wsClient.on('connected', () => {
  console.log('✅ WebSocket 已连接');
});

// 监听认证成功事件
wsClient.on('authenticated', () => {
  console.log('🔐 认证成功');
});

// 监听断开事件
wsClient.on('disconnected', (reason) => {
  console.log(`❌ 连接已断开: ${reason}`);
});

// 监听重连事件
wsClient.on('reconnecting', (attempt) => {
  console.log(`🔄 正在进行第 ${attempt} 次重连...`);
});

// 监听错误事件
wsClient.on('error', (error) => {
  console.error('⚠️ 发生错误:', error.message);
});

// 监听所有消息
wsClient.on('message', (frame: WsFrame) => {
  console.log('📨 收到消息:', JSON.stringify(frame.body).substring(0, 200));
});

// 监听文本消息，使用流式回复
wsClient.on('message.text', (frame: WsFrame) => {
  const body = frame.body;
  console.log(`📝 收到文本消息: ${body.text?.content}`);

  // 生成一个流式消息 ID
  const streamId = generateReqId('stream');

  // 测试主动发送消息（将 CHATID 替换为实际的会话 ID）
  // wsClient.sendMessage(body.from.userid, {
  //   msgtype: 'markdown',
  //   markdown: { content: '这是一条**主动推送**的消息' },
  // });

  // // 发送流式中间内容
  // wsClient.replyStream(frame, streamId, '<think></think>', false);
  //
  // // 模拟异步处理后发送最终结果
  // setTimeout(() => {
  //   wsClient.replyStream(frame, streamId, `你好！你说的是`, false);
  // }, 2000);
  //
  // setTimeout(() => {
  //   wsClient.replyStream(frame, streamId, `你好！你说的是: "${body.text?.content}"`, true);
  //   console.log('✅ 流式回复完成');
  // }, 3000);

  // // 卡片
  // setTimeout(() => {
  //   wsClient.replyTemplateCard(frame, templateCard);
  // }, 1000);

  // // 流式卡片
  // setTimeout(() => {
  //   wsClient.replyStreamWithCard(frame, streamId, 'hi', false, {
  //     templateCard: templateCard
  //   });
  // }, 1000);
  // setTimeout(() => {
  //   wsClient.replyStreamWithCard(frame, streamId, 'hi hhhhhhhhh', true);
  // }, 2000);

});

// 监听图片消息，下载并解密
wsClient.on('message.image', async (frame: WsFrame) => {
  const body = frame.body;
  const imageUrl = body.image?.url;
  console.log(`🖼️ 收到图片消息: ${imageUrl}`);

  if (!imageUrl) return;

  try {
    // 下载图片并使用消息中的 aeskey 解密
    const { buffer, filename } = await wsClient.downloadFile(imageUrl, body.image?.aeskey);
    console.log(`✅ 图片下载成功，大小: ${buffer.length} bytes`);

    // 优先使用响应头中的文件名，其次从 URL 提取，最后用时间戳作为默认名
    const urlPath = new URL(imageUrl).pathname;
    const fileName = filename || path.basename(urlPath) || `image_${Date.now()}`;
    const savePath = path.join(__dirname, fileName);
    fs.writeFileSync(savePath, buffer);
    console.log(`💾 图片已保存到: ${savePath}`);
  } catch (error: any) {
    console.error('❌ 图片下载失败:', error.message);
  }
});

// 监听图文混排消息
wsClient.on('message.mixed', (frame: WsFrame) => {
  const body = frame.body;
  const items = body.mixed?.msg_item || [];
  console.log(`🖼️ 收到图文混排消息，包含 ${items.length} 个子项`);

  items.forEach((item: any, index: number) => {
    if (item.msgtype === 'text') {
      console.log(`  [${index}] 文本: ${item.text?.content}`);
    } else if (item.msgtype === 'image') {
      console.log(`  [${index}] 图片: ${item.image?.url}`);
    }
  });
});

// 监听语音消息
wsClient.on('message.voice', (frame: WsFrame) => {
  const body = frame.body;
  console.log(`🎙️ 收到语音消息（转文本）: ${body.voice?.content}`);
});

// 监听文件消息
wsClient.on('message.file', async (frame: WsFrame) => {
  const body = frame.body;
  const fileUrl = body.file?.url;
  console.log(`📁 收到文件消息: ${fileUrl}`);

  if (!fileUrl) return;

  try {
    const { buffer, filename } = await wsClient.downloadFile(fileUrl, body.file?.aeskey);
    console.log(`✅ 文件下载成功，大小: ${buffer.length} bytes`);

    // 优先使用响应头中的文件名，其次从 URL 提取，最后用时间戳作为默认名
    const urlPath = new URL(fileUrl).pathname;
    const fileName = filename || path.basename(urlPath) || `file_${Date.now()}`;
    const savePath = path.join(__dirname, fileName);
    fs.writeFileSync(savePath, buffer);
    console.log(`💾 文件已保存到: ${savePath}`);
  } catch (error: any) {
    console.error('❌ 文件下载失败:', error.message);
  }
});

// 监听进入会话事件（发送欢迎语）
wsClient.on('event.enter_chat', (frame: WsFrame) => {
  console.log('👋 用户进入会话');
  wsClient.replyWelcome(frame, {
    msgtype: 'text',
    text: { content: '您好！我是智能助手，有什么可以帮您的吗？' },
  });
});

// 监听模板卡片事件
wsClient.on('event.template_card_event', (frame: WsFrame) => {
  const body = frame.body;
  console.log(`🃏 收到模板卡片事件: ${body.event?.event_key}`);
});

// 监听用户反馈事件
wsClient.on('event.feedback_event', (frame: WsFrame) => {
  const body = frame.body;
  console.log('💬 收到用户反馈事件:', JSON.stringify(body.event));
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在停止机器人...');
  wsClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  wsClient.disconnect();
  process.exit(0);
});
