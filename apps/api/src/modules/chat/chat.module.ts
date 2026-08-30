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

@Module({
  imports: [
    TypeOrmModule.forFeature([ConversationEntity, MessageEntity, QaRecordEntity]),
    AuthModule,
    AgentsModule,
    MemoryModule,
  ],
  controllers: [ChatController, AguiController],
  providers: [ChatService],
})
export class ChatModule {}
