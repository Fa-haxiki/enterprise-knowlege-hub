import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { SystemRole, UserStatus } from '@ekh/shared';
import { AdminService } from './admin.service';
import { AdminGuard } from '../../common/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';

class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @IsOptional()
  @IsIn([SystemRole.SYSADMIN, SystemRole.MEMBER])
  role?: SystemRole;

  /** 可选：创建后直接加入该部门成为成员 */
  @IsOptional()
  @IsUUID()
  department_id?: string;
}

class RejectUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

class UpdateUserDto {
  @IsOptional()
  @IsIn([SystemRole.SYSADMIN, SystemRole.MEMBER])
  role?: SystemRole;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

class DepartmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

@ApiTags('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ---------- 用户管理 ----------

  @Get('users')
  listUsers(
    @Query('status') status?: UserStatus,
    @Query('keyword') keyword?: string,
    @Query('page') page = 1,
    @Query('page_size') pageSize = 20,
  ) {
    return this.admin.listUsers({ status, keyword, page: Number(page), pageSize: Number(pageSize) });
  }

  /** 管理员手动添加用户（直接激活，无需审核） */
  @Post('users')
  createUser(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.admin.createUser(user.userId, dto);
  }

  @Post('users/:id/approve')
  approveUser(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.approveUser(user.userId, id);
  }

  @Post('users/:id/reject')
  rejectUser(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectUserDto,
  ) {
    return this.admin.rejectUser(user.userId, id, dto.reason);
  }

  @Patch('users/:id')
  updateUser(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.admin.updateUser(user.userId, id, dto);
  }

  // ---------- 部门管理 ----------

  @Get('departments')
  listDepartments() {
    return this.admin.listDepartments();
  }

  /** 部门详情（管理员+成员列表）：前端点击部门时按需加载 */
  @Get('departments/:id')
  getDepartmentDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.getDepartmentDetail(id);
  }

  @Post('departments')
  createDepartment(@CurrentUser() user: AuthUser, @Body() dto: DepartmentDto) {
    return this.admin.createDepartment(user.userId, dto.name, dto.description);
  }

  @Patch('departments/:id')
  updateDepartment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.admin.updateDepartment(user.userId, id, dto);
  }

  @Delete('departments/:id')
  removeDepartment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.removeDepartment(user.userId, id);
  }

  @Put('departments/:id/admins/:userId')
  addDepartmentAdmin(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.admin.addDepartmentAdmin(user.userId, id, userId);
  }

  @Delete('departments/:id/admins/:userId')
  removeDepartmentAdmin(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.admin.removeDepartmentAdmin(user.userId, id, userId);
  }
}
