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
