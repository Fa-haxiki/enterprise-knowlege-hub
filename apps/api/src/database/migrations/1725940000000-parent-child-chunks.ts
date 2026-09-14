import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 父子分块：document_chunks 增加 role / parent_id，HNSW 改为只索引有向量的子块。
 */
export class ParentChildChunks1725940000000 implements MigrationInterface {
  name = 'ParentChildChunks1725940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_chunks
      ADD COLUMN IF NOT EXISTS role varchar(16) NOT NULL DEFAULT 'child'
    `);
    await queryRunner.query(`
      ALTER TABLE document_chunks
      ADD COLUMN IF NOT EXISTS parent_id uuid
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE document_chunks
        ADD CONSTRAINT fk_chunks_parent
        FOREIGN KEY (parent_id) REFERENCES document_chunks(id) ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_chunks_parent ON document_chunks(parent_id)`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_chunks_role ON document_chunks(document_id, role)`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS idx_chunks_embedding`);
    await queryRunner.query(`
      CREATE INDEX idx_chunks_embedding
      ON document_chunks USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_chunks_embedding`);
    await queryRunner.query(`
      CREATE INDEX idx_chunks_embedding
      ON document_chunks USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_chunks_role`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_chunks_parent`);
    await queryRunner.query(`
      ALTER TABLE document_chunks DROP CONSTRAINT IF EXISTS fk_chunks_parent
    `);
    await queryRunner.query(`ALTER TABLE document_chunks DROP COLUMN IF EXISTS parent_id`);
    await queryRunner.query(`ALTER TABLE document_chunks DROP COLUMN IF EXISTS role`);
  }
}
