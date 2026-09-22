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
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { ChatService } from './chat.service';
import { AuditService } from '../audit/audit.service';

/** 重命名会话：标题非空，最长 256 字 */
class RenameDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  title: string;
}

/** 消息反馈：1 赞、-1 踩，可选文字说明 */
class FeedbackDto {
  @IsIn([1, -1])
  feedback: 1 | -1;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/**
 * 会话与消息的 REST 接口（v1）。
 * 流式问答不在这里，见 AguiController。
 * 全部接口要求登录，且只操作当前用户自己的会话。
 */
@ApiTags('chat')
@UseGuards(JwtAuthGuard)
@Controller({ version: '1' })
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly audit: AuditService,
  ) {}

  /** 当前用户的会话列表，按最近更新倒序分页 */
  @Get('conversations')
  listConversations(
    @CurrentUser() user: AuthUser,
    @Query('page') page = 1,
    @Query('page_size') pageSize = 20,
  ) {
    return this.chat.listConversations(user.userId, Number(page), Number(pageSize));
  }

  /** 某个会话的历史消息，page=1 是最新一页，继续加页码翻更早的消息 */
  @Get('conversations/:id/messages')
  listMessages(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page = 1,
    @Query('page_size') pageSize = 50,
  ) {
    return this.chat.listMessages(user.userId, id, Number(page), Number(pageSize));
  }

  /** 修改会话标题 */
  @Patch('conversations/:id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameDto,
  ) {
    return this.chat.rename(user.userId, id, dto.title);
  }

  /** 删除会话（消息随外键级联清理） */
  @Delete('conversations/:id')
  removeConversation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.remove(user.userId, id);
  }

  /** 对一条助手消息点赞或点踩，并写入审计日志 */
  @Post('messages/:id/feedback')
  async feedback(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FeedbackDto,
  ) {
    const result = await this.chat.feedback(user.userId, id, dto.feedback, dto.comment);
    // 反馈写库成功后再记审计，避免失败请求也留下操作记录
    this.audit.record({
      userId: user.userId,
      action: 'feedback',
      resourceType: 'message',
      resourceId: id,
      detail: { feedback: dto.feedback },
    });
    return result;
  }
}
