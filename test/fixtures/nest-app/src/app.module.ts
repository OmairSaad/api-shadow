import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { UsersModule } from './users/users.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    UsersModule,
    AdminModule,
    RouterModule.register([{ path: 'admin', module: AdminModule }]),
  ],
  controllers: [HealthController],
})
export class AppModule {}
