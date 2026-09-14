import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { DocumentEntity } from './document.entity';

@Entity('document_chunks')
@Unique(['documentId', 'chunkIndex'])
export class DocumentChunkEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  /** 冗余列：向量召回 SQL 直接做 ACL 前置过滤，避免 JOIN */
  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @Column({ name: 'chunk_index', type: 'int' })
  chunkIndex: number;

  /** parent=生成上下文；child=检索单元 */
  @Column({ type: 'varchar', length: 16, default: 'child' })
  @Index()
  role: 'parent' | 'child';

  /** 子块指向父块；父块为 null */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  @Index()
  parentId: string | null;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'heading_path', type: 'jsonb', default: [] })
  headingPath: string[];

  /** { page, bbox, table_id } 等原文定位信息 */
  @Column({ type: 'jsonb', default: {} })
  refs: { page?: number; bbox?: number[]; table_id?: string };

  /** bge-m3 1024 维；HNSW 索引由 DatabaseInitService 幂等创建 */
  @Column({
    name: 'embedding',
    // TypeORM 未内置 vector 类型，pgvector 扩展存在时 PG 原生支持
    type: 'vector' as never,
    length: 1024,
    nullable: true,
  })
  embedding: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
