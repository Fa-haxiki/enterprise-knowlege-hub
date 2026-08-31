import 'reflect-metadata';
import { createHash } from 'crypto';
import * as Minio from 'minio';
import { IsNull } from 'typeorm';
import { AppDataSource } from './data-source';
import { DocumentEntity } from './entities/document.entity';

/**
 * 历史文档 content_hash 回填：pnpm backfill:hash
 * 从 MinIO 读取文件内容计算 sha256 写回 documents.content_hash；
 * 已删除或对象缺失的文档跳过（保持 NULL，不参与查重）。
 */
async function backfill() {
  await AppDataSource.initialize();
  const documents = AppDataSource.getRepository(DocumentEntity);

  const minio = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: parseInt(process.env.MINIO_PORT ?? '9000', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_USER ?? 'ekh',
    secretKey: process.env.MINIO_PASSWORD ?? '',
  });
  const bucket = process.env.MINIO_BUCKET ?? 'ekh-docs';

  const docs = await documents.find({ where: { contentHash: IsNull() } });
  console.log(`found ${docs.length} documents without content_hash`);

  let done = 0;
  let skipped = 0;
  for (const doc of docs) {
    if (doc.deletedAt) {
      skipped++;
      continue;
    }
    try {
      const stream = await minio.getObject(bucket, doc.fileKey);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      const hash = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
      await documents.update(doc.id, { contentHash: hash });
      done++;
      console.log(`  ${doc.title} -> ${hash.slice(0, 12)}...`);
    } catch (e) {
      skipped++;
      console.warn(`  skip ${doc.title}: ${(e as Error).message}`);
    }
  }
  console.log(`backfill done: ${done} updated, ${skipped} skipped`);
  await AppDataSource.destroy();
}

backfill().catch((e) => {
  console.error(e);
  process.exit(1);
});
