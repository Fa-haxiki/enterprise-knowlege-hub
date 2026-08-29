# 数据库与 TypeORM 坑点

## TypeORM 无法推断 `string | null` 联合类型的列

- **现象**：`Data type "Object" in "AuditLogEntity.userId" is not supported`
- **根因**：联合类型使元数据推断失败
- **修复**：显式声明 `@Column({ type: 'uuid', nullable: true })` / `{ type: 'varchar', length: 32 }`
- **相关**：`apps/api/src/database/entities/*.entity.ts`

## TypeORM synchronize 与手写生成列冲突

- **现象**：启动报 `relation "typeorm_metadata" does not exist`
- **根因**：`DatabaseInitService` 手写了实体未声明的生成列 `content_tsv`，synchronize 检测生成列时会查 `typeorm_metadata` 且可能 DROP 未声明列
- **修复**：实体未声明的列/索引一律交给 migration 管理，bootstrap 阶段只做幂等的扩展与索引创建
- **相关**：`apps/api/src/database/database-init.service.ts`

## TypeORM `vector` 列类型 TypeScript 报错

- **现象**：`type: 'vector'` 不在 `ColumnType` 枚举中，编译失败
- **修复**：`type: 'vector' as never` 断言绕过（pgvector 实际支持）
- **相关**：`apps/api/src/database/entities/document-chunk.entity.ts`

## autoLoadEntities 未同步部分实体

- **现象**：`document_chunks`、`ingestion_jobs` 表缺失，尽管开了 `autoLoadEntities: true`
- **根因**：实体未被任何 `TypeOrmModule.forFeature` 引用时不会注册
- **修复**：在 `TypeOrmModule.forRoot` 的 `entities` 数组中显式补齐
- **相关**：`apps/api/src/app.module.ts`
