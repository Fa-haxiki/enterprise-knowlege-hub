# 数据库与 TypeORM 坑点

## TypeORM where 条件写 `field: undefined` 会被静默忽略

- **现象**：软删文档仍出现在列表接口；再点删除时 `mustGet` 报 404「文档不存在」，前后表现矛盾
- **根因**：查询条件写成 `where: { deletedAt: undefined }`，TypeORM 对值为 `undefined` 的条件直接丢弃（不报错），等于没有过滤
- **修复**：软删过滤必须用 `deletedAt: IsNull()`；排查同类写法可全局搜 `: undefined` 检查是否落在 TypeORM where 中
- **相关**：`apps/api/src/modules/documents/documents.service.ts` list / pendingReviewList

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

## TypeORM 实体字段写 `string | null` 联合类型报 DataTypeNotSupportedError

- **现象**：`DataTypeNotSupportedError: Data type "Object" in "DepartmentReviewerEntity.grantedBy" is not supported by "postgres"`，TypeORM 连接一直重试，新表全部建不出来
- **根因**：`@Column({ nullable: true })` 配 `string | null` 时 TS 反射元数据是 `Object`，TypeORM 无法推断列类型（`design:type` 被联合类型抹掉）
- **修复**：联合类型字段必须显式写 `type`，如 `@Column({ type: 'uuid', nullable: true })`；本次涉及 granted_by / department_id / reviewed_by 三处
- **相关**：`apps/api/src/database/entities/department-reviewer.entity.ts`、`workspace.entity.ts`、`document.entity.ts`

## QueryBuilder join 后 orderBy 用列名报 databaseName undefined

- **现象**：`documents.list` 加 `leftJoin('d.uploader','u') + addSelect` 后接口 500：`Cannot read properties of undefined (reading 'databaseName')`，堆栈在 `createOrderByCombinedWithSelectExpression`
- **根因**：`orderBy('d.created_at')` 用的是数据库列名；无 join 时 TypeORM 容忍，但 join + 分页（skip/take）时 ORDER BY 改走「按实体属性路径解析元数据」的代码路径，列名找不到属性 → undefined
- **修复**：QueryBuilder 的 orderBy 一律用实体属性路径（`d.createdAt`），不要用数据库列名
- **相关**：`apps/api/src/modules/documents/documents.service.ts`
