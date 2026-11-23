import { INodeConnectionOpts } from '@common/axios';

export interface INodeHealthCheckPayload {
    nodeUuid: string;
    xrayConnected: boolean;
    connectionOpts: INodeConnectionOpts;
}
