import { MigrationInterface, QueryRunner } from 'typeorm';

/** 历史回放：步骤时间线 + 建议检索词 */
export class AgenticStepTrace1726801000000 implements MigrationInterface {
  name = 'AgenticStepTrace1726801000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE qa_records ADD COLUMN IF NOT EXISTS step_trace jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(`ALTER TABLE qa_records ADD COLUMN IF NOT EXISTS suggested_query text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE qa_records DROP COLUMN IF EXISTS suggested_query`);
    await queryRunner.query(`ALTER TABLE qa_records DROP COLUMN IF EXISTS step_trace`);
  }
}
