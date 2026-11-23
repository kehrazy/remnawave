import { Module } from '@nestjs/common';
import { ManagedVpnService } from './managed-vpn.service';

@Module({ providers: [ManagedVpnService], exports: [ManagedVpnService] })
export class ManagedVpnModule {}
