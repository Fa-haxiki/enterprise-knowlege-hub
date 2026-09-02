import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../../database/entities/user.entity';
import { DepartmentAdminEntity } from '../../database/entities/department-admin.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * 设为全局模块：JwtAuthGuard 被各业务模块 @UseGuards 使用，
 * 其依赖 UserEntityRepository / RedisService 需在所有模块上下文可注入。
 */
@Global()
@Module({
  imports: [JwtModule.register({}), TypeOrmModule.forFeature([UserEntity, DepartmentAdminEntity])],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule, TypeOrmModule],
})
export class AuthModule {}
