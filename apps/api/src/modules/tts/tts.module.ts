import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TtsGateway } from './tts.gateway';

@Module({
  imports: [AuthModule],
  providers: [TtsGateway],
})
export class TtsModule {}
