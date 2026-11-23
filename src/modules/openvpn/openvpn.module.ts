import { Module } from '@nestjs/common';

import { ManagedVpnModule } from '@common/vpn/managed-vpn.module';

import { AxiosModule } from '@common/axios';

import { OpenVpnController, OpenVpnSubscriptionController } from './openvpn.controller';
import { OpenVpnService } from './openvpn.service';

@Module({
    imports: [AxiosModule, ManagedVpnModule],
    controllers: [OpenVpnController, OpenVpnSubscriptionController],
    providers: [OpenVpnService],
    exports: [OpenVpnService],
})
export class OpenVpnModule {}
