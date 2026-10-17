import { Injectable } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  findAll(page?: number) {
    return { page, items: [] };
  }

  findOne(id: string) {
    return { id };
  }

  create(dto: CreateUserDto) {
    return dto;
  }

  update(id: string, dto: Partial<CreateUserDto>) {
    return { id, ...dto };
  }

  remove(id: string) {
    return { id };
  }
}
