import { Controller, Get, Headers, Version, VERSION_NEUTRAL } from '@nestjs/common';

@Controller('reports')
@Version(VERSION_NEUTRAL)
export class AdminController {
  @Get(['stats', 'statistics'])
  stats(@Headers('x-tenant') tenant: string) {
    return { tenant };
  }
}
