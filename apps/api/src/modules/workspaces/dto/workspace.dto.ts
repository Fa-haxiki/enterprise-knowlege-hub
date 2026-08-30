import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { WorkspaceRole } from '@ekh/shared';

export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** 挂靠部门（必填）：决定文档审核归属，只能选自己所属的部门 */
  @IsUUID()
  department_id: string;
}

export class UpdateWorkspaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** 挂靠部门：决定文档审核员；传 null 解除挂靠（审核落入 sysadmin 兜底） */
  @IsOptional()
  @IsUUID()
  department_id?: string | null;
}

export class AddMemberDto {
  @IsUUID()
  user_id: string;

  @IsIn([WorkspaceRole.OWNER, WorkspaceRole.EDITOR, WorkspaceRole.VIEWER])
  role: WorkspaceRole;
}

export class UpdateMemberDto {
  @IsIn([WorkspaceRole.OWNER, WorkspaceRole.EDITOR, WorkspaceRole.VIEWER])
  role: WorkspaceRole;
}
