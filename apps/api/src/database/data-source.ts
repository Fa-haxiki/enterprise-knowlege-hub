import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as path from 'path';
import * as dotenv from 'dotenv';

// src/database 与 dist/database 到项目根均为四级，.env 在仓库根
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

export const AppDataSource = new DataSource({
  type: 'postgres',
  url:
    process.env.DATABASE_URL ??
    `postgresql://${process.env.PG_USER ?? 'postgres'}:${process.env.PG_PASSWORD}@${process.env.PG_HOST ?? 'localhost'}:${process.env.PG_PORT ?? '5432'}/${process.env.PG_DB ?? 'ekh'}`,
  entities: [path.join(__dirname, 'entities/*.entity.{ts,js}')],
  migrations: [path.join(__dirname, 'migrations/*.{ts,js}')],
  synchronize: false,
});
