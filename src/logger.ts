import type { Logger } from './types';

/**
 * 默认日志实现
 * 带有日志级别和时间戳的控制台日志
 */
export class DefaultLogger implements Logger {
  private prefix: string;

  constructor(prefix: string = 'AiBotSDK') {
    this.prefix = prefix;
  }

  private formatTime(): string {
    return new Date().toISOString();
  }

  debug(message: string, ...args: any[]): void {
    console.debug(`[${this.formatTime()}] [${this.prefix}] [DEBUG] ${message}`, ...args);
  }

  info(message: string, ...args: any[]): void {
    console.info(`[${this.formatTime()}] [${this.prefix}] [INFO] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[${this.formatTime()}] [${this.prefix}] [WARN] ${message}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`[${this.formatTime()}] [${this.prefix}] [ERROR] ${message}`, ...args);
  }
}
