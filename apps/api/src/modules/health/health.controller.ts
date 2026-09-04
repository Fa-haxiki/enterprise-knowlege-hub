import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EsService } from '../retrieval/es.service';
import { RedisService } from '../../redis/redis.service';
import { GraphService } from '../graph/graph.service';
import { Public } from '../auth/guards/jwt-auth.guard';

@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly es: EsService,
    private readonly graph: GraphService,
  ) {}

  @Get()
  liveness() {
    return { status: 'ok' };
  }

  @Get('deps')
  async deps() {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok';
      } catch {
        return 'down';
      }
    };
    return {
      postgres: await check(() => this.dataSource.query('SELECT 1')),
      redis: await check(() => this.redis.raw.ping()),
      elasticsearch: await check(() => this.es.ping()),
      neo4j: (await this.graph.ping()) ? 'ok' : 'down',
    };
  }
}
