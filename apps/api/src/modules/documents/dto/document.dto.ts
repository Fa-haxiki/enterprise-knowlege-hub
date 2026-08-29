import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

export class UploadInitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  filename: string;

  @IsInt()
  @Min(1)
  @Max(MAX_FILE_SIZE)
  file_size: number;

  @IsString()
  @MaxLength(128)
  mime_type: string;
}

export class UploadCompleteDto {
  @IsString()
  upload_id: string;

  @IsInt()
  @Min(1)
  part_count: number;
}
