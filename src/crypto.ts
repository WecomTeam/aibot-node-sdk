import crypto from 'crypto';

/**
 * 加解密工具模块
 * 提供文件加解密相关的功能函数
 */

/**
 * 使用 AES-256-CBC 解密文件
 *
 * @param encryptedBuffer - 加密的文件数据
 * @param aesKey - Base64 编码的 AES-256 密钥
 * @returns 解密后的文件 Buffer
 */
export function decryptFile(encryptedBuffer: Buffer, aesKey: string): Buffer {
  // 参数验证
  if (!encryptedBuffer || encryptedBuffer.length === 0) {
    throw new Error('decryptFile: encryptedBuffer is empty or not provided');
  }

  if (!aesKey || typeof aesKey !== 'string') {
    throw new Error('decryptFile: aesKey must be a non-empty string');
  }

  // 将 Base64 编码的 aesKey 解码为 Buffer
  const key = Buffer.from(aesKey, 'base64');

  // IV 取 aesKey 解码后的前 16 字节
  const iv = key.subarray(0, 16);

  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    // 关闭自动 padding，因为文档要求 PKCS#7 填充至 32 字节的倍数，
    // 而 Node.js 默认按 16 字节 block 去除 padding，会导致 bad decrypt 错误
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([
      decipher.update(encryptedBuffer),
      decipher.final(),
    ]);

    // 手动去除 PKCS#7 填充（支持 32 字节 block）
    const padLen = decrypted[decrypted.length - 1];
    if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
      throw new Error(`Invalid PKCS#7 padding value: ${padLen}`);
    }
    // 验证所有 padding 字节是否一致
    for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
      if (decrypted[i] !== padLen) {
        throw new Error('Invalid PKCS#7 padding: padding bytes mismatch');
      }
    }

    return decrypted.subarray(0, decrypted.length - padLen);
  } catch (error: any) {
    throw new Error(`decryptFile: Decryption failed - ${error.message}. This may indicate corrupted data or an incorrect aesKey.`);
  }
}
