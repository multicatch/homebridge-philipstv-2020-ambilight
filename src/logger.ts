import { Logger } from 'homebridge';

export class Log {
  constructor(
        private readonly logger: Logger,
        private readonly accessoryId: string,
  ) {

  }

  info(message: string, ...parameters: unknown[]) {
    this.logger.info(this.prepareMessage(message), parameters);
  }

  success(message: string, ...parameters: unknown[]) {
    this.logger.success(this.prepareMessage(message), parameters);
  }

  warn(message: string, ...parameters: unknown[]){
    this.logger.warn(this.prepareMessage(message), parameters);
  }
    
  error(message: string, ...parameters: unknown[]){
    this.logger.error(this.prepareMessage(message), parameters);
  }

  debug(message: string, ...parameters: unknown[]){
    this.logger.debug(this.prepareMessage(message), parameters);
  }

  private prepareMessage(message: string) {
    return `[${this.accessoryId}] ${message}`;
  }
}