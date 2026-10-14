import { MigrationInterface, QueryRunner } from 'typeorm';

/** 部门文档发布到公司公共空间：发布标记 + 全公司唯一的公共空间 */
export class CompanyPublish1727000000000 implements MigrationInterface {
  name = 'CompanyPublish1727000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE documents ADD COLUMN IF NOT EXISTS company_published_at timestamptz`,
    );
    await queryRunner.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS published_by uuid`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_company_published
      ON documents (company_published_at)
      WHERE company_published_at IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_company
      ON workspaces (visibility)
      WHERE visibility = 'company'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_workspaces_company`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_documents_company_published`);
    await queryRunner.query(`ALTER TABLE documents DROP COLUMN IF EXISTS published_by`);
    await queryRunner.query(`ALTER TABLE documents DROP COLUMN IF EXISTS company_published_at`);
  }
}
