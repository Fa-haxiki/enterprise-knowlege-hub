import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationEntity } from '../../database/entities/conversation.entity';
import { MessageEntity } from '../../database/entities/message.entity';
import { QaRecordEntity } from '../../database/entities/qa-record.entity';
import { AuthModule } from '../auth/auth.module';
import { AgentsModule } from '../agents/agents.module';
import { MemoryModule } from '../memory/memory.module';
import { ChatController } from './chat.controller';
import { AguiController } from './agui.controller';
import { ChatService } from './chat.service';
import { ChatRunService } from './chat-run.service';

/**
 * 对话模块：会话列表、消息回放、反馈，以及 AG-UI 流式问答入口。
 * 问答本身由 AgentsModule 执行，本模块负责落库、记忆与对外 HTTP。
 */
@Module({
  imports: [
    // 注册会话、消息、问答记录三张表的 Repository
    TypeOrmModule.forFeature([ConversationEntity, MessageEntity, QaRecordEntity]),
    // JWT 鉴权（CurrentUser / JwtAuthGuard）
    AuthModule,
    // Agent 编排：检索、推理、流式生成
    AgentsModule,
    // 短期窗口与长期记忆
    MemoryModule,
  ],
  // ChatController 管会话 CRUD；AguiController 管流式问答
  controllers: [ChatController, AguiController],
  providers: [ChatService, ChatRunService],
})
export class ChatModule {}
