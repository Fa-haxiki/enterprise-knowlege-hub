import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogEntity } from '../../database/entities/audit-log.entity';
import { DocumentEntity } from '../../database/entities/document.entity';
import { MessageEntity } from '../../database/entities/message.entity';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from './audit.service';
import { AclAlertService } from './acl-alert.service';
import { AuditController } from './audit.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntity, DocumentEntity, MessageEntity]), AuthModule],
  controllers: [AuditController],
  providers: [AuditService, AclAlertService],
  exports: [AuditService, AclAlertService],
})
export class AuditModule {}
