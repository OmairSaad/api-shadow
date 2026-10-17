import * as vscode from 'vscode';
import type { Logger } from '../core/types';

/** Logger backed by a VS Code LogOutputChannel (log level controlled by the user via "Set Log Level"). */
export class ChannelLogger implements Logger, vscode.Disposable {
  readonly channel: vscode.LogOutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  trace(message: string): void {
    this.channel.trace(message);
  }
  debug(message: string): void {
    this.channel.debug(message);
  }
  info(message: string): void {
    this.channel.info(message);
  }
  warn(message: string): void {
    this.channel.warn(message);
  }
  error(message: string | Error): void {
    this.channel.error(message);
  }
  show(): void {
    this.channel.show(true);
  }
  dispose(): void {
    this.channel.dispose();
  }
}
