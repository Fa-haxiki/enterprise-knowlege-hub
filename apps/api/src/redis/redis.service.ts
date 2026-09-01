import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.config.get<string>('redis.host'),
      port: this.config.get<number>('redis.port'),
      password: this.config.get<string>('redis.password'),
      lazyConnect: false,
    });
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  get raw(): Redis {
    return this.client;
  }

  /* 获取集合成员 */
  async getSet(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  /* 刷新集合成员 */
  async refreshSet(key: string, members: string[], ttlSeconds: number): Promise<void> {
    const pipeline = this.client.pipeline();
    pipeline.del(key);
    if (members.length > 0) pipeline.sadd(key, ...members);
    pipeline.expire(key, ttlSeconds);
    await pipeline.exec();
  }
}
