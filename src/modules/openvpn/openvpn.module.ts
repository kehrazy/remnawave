import { Module } from '@nestjs/common';

import { AxiosModule } from '@common/axios';

import { OpenVpnController, OpenVpnSubscriptionController } from './openvpn.controller';
import { OpenVpnService } from './openvpn.service';

@Module({
    imports: [AxiosModule],
    controllers: [OpenVpnController, OpenVpnSubscriptionController],
    providers: [OpenVpnService],
    exports: [OpenVpnService],
})
export class OpenVpnModule {}
