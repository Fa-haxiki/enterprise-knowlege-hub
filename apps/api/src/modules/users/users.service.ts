import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '@ekh/shared';
import { UserEntity } from '../../database/entities/user.entity';
import { BizException } from '../../common/filters/http-exception.filter';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  async findById(id: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new BizException(ErrorCode.NOT_FOUND, '用户不存在', 404);
    const { passwordHash: _ph, ...safe } = user;
    return safe;
  }

  async updateProfile(id: string, patch: { name?: string }) {
    await this.users.update(id, patch);
    return this.findById(id);
  }
}
