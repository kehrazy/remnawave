import { Module } from '@nestjs/common';

import { NativeVpnModule } from '@common/vpn/native-vpn.module';

import { OpenVpnSubscriptionController } from './openvpn.controller';

@Module({ imports: [NativeVpnModule], controllers: [OpenVpnSubscriptionController] })
export class OpenVpnModule {}
