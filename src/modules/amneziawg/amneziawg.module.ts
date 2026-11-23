import { Module } from '@nestjs/common';

import { NativeVpnModule } from '@common/vpn/native-vpn.module';

import { AmneziaWgSubscriptionController } from './amneziawg.controller';

@Module({ imports: [NativeVpnModule], controllers: [AmneziaWgSubscriptionController] })
export class AmneziaWgModule {}
