import { Global, Module } from '@nestjs/common';
import { PromptInjectionService } from './prompt-injection.service';
import { MaskService } from './mask.service';

@Global()
@Module({
  providers: [PromptInjectionService, MaskService],
  exports: [PromptInjectionService, MaskService],
})
export class SecurityModule {}
