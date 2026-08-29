import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始 migration：扩展、HNSW 向量索引、全文兜底索引。
 * 表结构由 TypeORM synchronize（开发）/ 后续 migration（生产）维护，
 * 此处仅处理 TypeORM 无法表达的 PG 特性。
 */
export class Init1700000000000 implements MigrationInterface {
  name = 'Init1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // HNSW 向量索引（余弦距离）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding
      ON document_chunks USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);

    // ES 故障时的兜底全文索引（simple 分词，仅降级用）
    await queryRunner.query(`
      ALTER TABLE document_chunks
      ADD COLUMN IF NOT EXISTS content_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_tsv
      ON document_chunks USING gin(content_tsv)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_chunks_tsv`);
    await queryRunner.query(
      `ALTER TABLE document_chunks DROP COLUMN IF EXISTS content_tsv`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_chunks_embedding`);
  }
}
