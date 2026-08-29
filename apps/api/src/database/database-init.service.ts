import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * 启动时幂等初始化 PG 扩展与索引。
 * 表结构由 TypeORM synchronize 维护；此处处理其无法表达的 PG 特性。
 * 全部语句幂等，可随每次启动执行。
 */
@Injectable()
export class DatabaseInitService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseInitService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap() {
    // synchronize 建表可能晚于本钩子（连接重试等），轮询等待表就绪
    for (let i = 0; i < 30; i++) {
      const ready = await this.tableExists('document_chunks');
      if (ready) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    try {
      await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      // 注意：不向表中添加实体未声明的列（如 content_tsv 兜底列），
      // 否则 synchronize 会检测生成列并查询 typeorm_metadata，且可能 DROP 未声明列。
      // ES 故障时的 PG 全文兜底改由 migration 在生产的 schema 冻结后提供。
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_chunks_embedding
        ON document_chunks USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);
      this.logger.log('database extensions & indexes ready');
    } catch (e) {
      this.logger.warn(`database init skipped: ${(e as Error).message}`);
    }
  }

  private async tableExists(table: string): Promise<boolean> {
    try {
      const rows = await this.dataSource.query(
        `SELECT 1 FROM pg_tables WHERE tablename = $1`,
        [table],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }
}
