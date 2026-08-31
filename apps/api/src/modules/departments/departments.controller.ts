import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsNotEmpty, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { DepartmentsService } from './departments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';

class AddMemberDto {
  @IsUUID()
  @IsNotEmpty()
  user_id: string;
}

class CreateMemberDto {
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
}

class SetDisabledDto {
  @IsBoolean()
  disabled: boolean;
}

@ApiTags('departments')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'departments', version: '1' })
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  /** 我管理的部门（部门管理员视角），须在 :id 路由前注册 */
  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.departments.myManagedDepartments(user.userId);
  }

  @Get(':id/members')
  members(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.departments.listMembers(user, id);
  }

  @Get(':id/candidates')
  candidates(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('keyword') keyword?: string,
  ) {
    return this.departments.candidates(user, id, keyword);
  }

  @Post(':id/members')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.departments.addMember(user, id, dto.user_id);
  }

  /** 初始化创建新成员账号并加入部门（部门管理员/sysadmin） */
  @Post(':id/members/create')
  createMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMemberDto,
  ) {
    return this.departments.createMember(user, id, dto);
  }

  /** 禁用/启用本部门成员（部门管理员/sysadmin） */
  @Patch(':id/members/:userId/disabled')
  setMemberDisabled(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetDisabledDto,
  ) {
    return this.departments.setMemberDisabled(user, id, userId, dto.disabled);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.departments.removeMember(user, id, userId);
  }
}
