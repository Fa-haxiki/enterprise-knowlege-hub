import 'reflect-metadata';
import * as argon2 from 'argon2';
import { AppDataSource } from './data-source';
import { UserEntity } from './entities/user.entity';
import { SystemRole } from '@ekh/shared';

/** 创建首个系统管理员：pnpm seed:admin */
async function seed() {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(UserEntity);

  const email = process.env.ADMIN_EMAIL ?? 'admin@ekh.local';
  const password = process.env.ADMIN_PASSWORD ?? 'admin123456';
  const name = process.env.ADMIN_NAME ?? '系统管理员';

  const exists = await repo.findOne({ where: { email } });
  if (exists) {
    // 已存在但角色不对时升级为 sysadmin（例如曾被 register 接口以 member 创建）
    if (exists.role !== SystemRole.SYSADMIN) {
      await repo.update(exists.id, { role: SystemRole.SYSADMIN });
      console.log(`admin ${email} role upgraded to sysadmin`);
    } else {
      console.log(`admin ${email} already exists, skipped`);
    }
    await AppDataSource.destroy();
    return;
  }

  await repo.save(
    repo.create({
      email,
      name,
      passwordHash: await argon2.hash(password),
      role: SystemRole.SYSADMIN,
    }),
  );
  console.log(`admin created: ${email}`);
  await AppDataSource.destroy();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
