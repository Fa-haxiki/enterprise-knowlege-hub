import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as Minio from 'minio';
import { v4 as uuid } from 'uuid';

const PART_SIZE = 8 * 1024 * 1024; // 8MB 分片
const PRESIGN_EXPIRY = 3600;

@Injectable()
export class StorageService implements OnModuleInit {
  private client: Minio.Client;
  private bucket: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.client = new Minio.Client({
      endPoint: this.config.get<string>('minio.endPoint') ?? 'localhost',
      port: this.config.get<number>('minio.port'),
      useSSL: this.config.get<boolean>('minio.useSSL') ?? false,
      accessKey: this.config.get<string>('minio.accessKey') ?? '',
      secretKey: this.config.get<string>('minio.secretKey') ?? '',
    });
    this.bucket = this.config.get<string>('minio.bucket') ?? 'ekh-docs';

    const exists = await this.client.bucketExists(this.bucket).catch(() => false);
    if (!exists) await this.client.makeBucket(this.bucket);
  }

  /**
   * 初始化分片上传：生成对象 key 与各分片预签名 URL。
   * MinIO 兼容 S3 分片上传；这里用预签名 PUT 直传，upload_id 由对象 key 派生。
   */
  async initMultipartUpload(filename: string, fileSize: number) {
    const key = `docs/${uuid()}/${encodeURIComponent(filename)}`;
    const partCount = Math.max(1, Math.ceil(fileSize / PART_SIZE));

    // MinIO SDK 的分片上传通过 S3 协议；预签名 URL 按单分片 PUT 生成
    const partUrls: string[] = [];
    for (let i = 1; i <= partCount; i++) {
      const url = await this.client.presignedPutObject(
        this.bucket,
        `${key}.part${i}`,
        PRESIGN_EXPIRY,
      );
      partUrls.push(url);
    }
    return { fileKey: key, uploadId: uuid(), partUrls, partSize: PART_SIZE };
  }

  /** 合并分片为最终对象，并计算内容 sha256（用于防重复上传） */
  async completeMultipartUpload(fileKey: string, partCount: number) {
    const parts: Buffer[] = [];
    for (let i = 1; i <= partCount; i++) {
      const stream = await this.client.getObject(this.bucket, `${fileKey}.part${i}`);
      parts.push(await this.streamToBuffer(stream));
    }
    const merged = Buffer.concat(parts);
    const contentHash = createHash('sha256').update(merged).digest('hex');
    await this.client.putObject(this.bucket, fileKey, merged, merged.length);

    // 清理分片
    for (let i = 1; i <= partCount; i++) {
      await this.client.removeObject(this.bucket, `${fileKey}.part${i}`).catch(() => undefined);
    }
    return { fileKey, size: merged.length, contentHash };
  }

  /** 浏览器可直接预览的 MIME 类型（其余一律附件下载） */
  static readonly INLINE_MIME = new Set([
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/html',
  ]);

  async presignDownload(
    fileKey: string,
    expirySeconds = 3600,
    filename?: string,
    mimeType?: string,
  ): Promise<string> {
    const inline = mimeType ? StorageService.INLINE_MIME.has(mimeType) : false;
    const encoded = encodeURIComponent(filename ?? 'download');
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`;
    return this.client.presignedGetObject(this.bucket, fileKey, expirySeconds, {
      'response-content-disposition': disposition,
      // 对象上传时 Content-Type 多为 octet-stream，不覆盖则浏览器无视 inline 直接下载
      'response-content-type': mimeType ?? 'application/octet-stream',
    });
  }

  async getObjectBuffer(fileKey: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, fileKey);
    return this.streamToBuffer(stream);
  }

  async remove(fileKey: string): Promise<void> {
    await this.client.removeObject(this.bucket, fileKey).catch(() => undefined);
  }

  private streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}
