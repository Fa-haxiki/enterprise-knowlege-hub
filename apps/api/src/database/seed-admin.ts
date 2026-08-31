import 'reflect-metadata';
import * as argon2 from 'argon2';
import { AppDataSource } from './data-source';
import { UserEntity } from './entities/user.entity';
import { DepartmentEntity } from './entities/department.entity';
import { DepartmentAdminEntity } from './entities/department-admin.entity';
import { DepartmentMemberEntity } from './entities/department-member.entity';
import { SystemRole, UserStatus } from '@ekh/shared';

/**
 * 初始化种子数据：pnpm seed:admin
 * - 系统管理员（sysadmin，ACTIVE）
 * - 示例部门 + 部门管理员 + 普通测试用户（均为 ACTIVE，便于开发联调）
 */
async function seed() {
  await AppDataSource.initialize();
  const users = AppDataSource.getRepository(UserEntity);
  const departments = AppDataSource.getRepository(DepartmentEntity);
  const deptAdmins = AppDataSource.getRepository(DepartmentAdminEntity);
  const deptMembers = AppDataSource.getRepository(DepartmentMemberEntity);

  const upsertUser = async (email: string, name: string, password: string, role: SystemRole) => {
    const exists = await users.findOne({ where: { email } });
    if (exists) {
      // 已存在时校正角色与状态（例如曾被 register 接口以 PENDING member 创建）
      await users.update(exists.id, { role, status: UserStatus.ACTIVE });
      console.log(`user ${email} exists, role/status synced`);
      return exists;
    }
    const user = await users.save(
      users.create({
        email,
        name,
        passwordHash: await argon2.hash(password),
        role,
        status: UserStatus.ACTIVE,
      }),
    );
    console.log(`user created: ${email} (${role})`);
    return user;
  };

  const admin = await upsertUser(
    process.env.ADMIN_EMAIL ?? 'admin@ekh.local',
    process.env.ADMIN_NAME ?? '系统管理员',
    process.env.ADMIN_PASSWORD ?? 'admin123456',
    SystemRole.SYSADMIN,
  );
  const deptAdmin = await upsertUser('dept-admin@ekh.local', '部门管理员', 'admin123456', SystemRole.MEMBER);
  const demo = await upsertUser('demo@ekh.local', '演示用户', 'demo123456', SystemRole.MEMBER);

  let dep = await departments.findOne({ where: { name: '综合管理部' } });
  if (!dep) {
    dep = await departments.save(departments.create({ name: '综合管理部', description: '示例部门，空间可挂靠到部门下由部门管理员审核文档' }));
    console.log('department created: 综合管理部');
  }
  if (!(await deptAdmins.exist({ where: { departmentId: dep.id, userId: deptAdmin.id } }))) {
    await deptAdmins.save(deptAdmins.create({ departmentId: dep.id, userId: deptAdmin.id, grantedBy: admin.id }));
    console.log('dept admin assigned: dept-admin@ekh.local -> 综合管理部');
  }
  if (!(await deptMembers.exist({ where: { departmentId: dep.id, userId: demo.id } }))) {
    await deptMembers.save(deptMembers.create({ departmentId: dep.id, userId: demo.id, addedBy: admin.id }));
    console.log('dept member added: demo@ekh.local -> 综合管理部');
  }

  await AppDataSource.destroy();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
