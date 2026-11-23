import { Module } from '@nestjs/common';

import { AxiosModule } from '@common/axios';

import { HostsModule } from '@modules/hosts/hosts.module';

import { ManagedVpnModule } from './managed-vpn.module';
import { NativeVpnService } from './native-vpn.service';

@Module({
    imports: [AxiosModule, ManagedVpnModule, HostsModule],
    providers: [NativeVpnService],
    exports: [NativeVpnService],
})
export class NativeVpnModule {}
