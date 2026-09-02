import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // 生产环境禁止弱 JWT 密钥：缺省值可伪造任意用户与角色
  if (config.get<string>('app.nodeEnv') === 'production') {
    const secret = config.get<string>('jwt.secret') ?? '';
    const weak = new Set(['dev-secret-change-me', 'secret', 'changeme', '']);
    if (secret.length < 32 || weak.has(secret)) {
      throw new Error('JWT_SECRET 未配置或过弱：生产环境必须设置长度 ≥ 32 的随机密钥');
    }
  }

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableCors({
    origin: config.get<string>('app.corsOrigin'),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Enterprise Knowledge Hub API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.get<number>('app.port') ?? 8080;
  await app.listen(port);
}

bootstrap();
