import { CanActivate, Injectable } from '@nestjs/common';

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate() {
    return true;
  }
}
