import { MigrationInterface, QueryRunner } from 'typeorm';

/** qa_records 增加意图 / 轮次 / 工具痕迹 / 思考，供 Agentic RAG 回放 */
export class AgenticQaFields1726800000000 implements MigrationInterface {
  name = 'AgenticQaFields1726800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE qa_records ADD COLUMN IF NOT EXISTS intent varchar(32)`);
    await queryRunner.query(`ALTER TABLE qa_records ADD COLUMN IF NOT EXISTS iterations int NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE qa_records ADD COLUMN IF NOT EXISTS tool_trace jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE qa_records ADD COLUMN IF NOT EXISTS thinking text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE qa_records DROP COLUMN IF EXISTS thinking`);
    await queryRunner.query(`ALTER TABLE qa_records DROP COLUMN IF EXISTS tool_trace`);
    await queryRunner.query(`ALTER TABLE qa_records DROP COLUMN IF EXISTS iterations`);
    await queryRunner.query(`ALTER TABLE qa_records DROP COLUMN IF EXISTS intent`);
  }
}
