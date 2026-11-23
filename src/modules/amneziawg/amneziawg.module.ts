import { Module } from '@nestjs/common';

import { ManagedVpnModule } from '@common/vpn/managed-vpn.module';

import { AxiosModule } from '@common/axios';

import { AmneziaWgController, AmneziaWgSubscriptionController } from './amneziawg.controller';
import { AmneziaWgService } from './amneziawg.service';

@Module({
    imports: [AxiosModule, ManagedVpnModule],
    controllers: [AmneziaWgController, AmneziaWgSubscriptionController],
    providers: [AmneziaWgService],
    exports: [AmneziaWgService],
})
export class AmneziaWgModule {}
