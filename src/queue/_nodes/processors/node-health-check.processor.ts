import { Job } from 'bullmq';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { GetSystemStatsCommand } from '@remnawave/node-contract';

import { AxiosService, INodeConnectionOpts } from '@common/axios';
import { RawCacheService } from '@common/raw-cache';
import { CACHE_KEYS, CACHE_KEYS_TTL } from '@libs/contracts/constants';

import { UpdateNodeCommand } from '@modules/nodes/commands/update-node';

import { NodesQueuesService } from '@queue/_nodes';
import { QUEUES_NAMES } from '@queue/queue.enum';

import { NODES_JOB_NAMES } from '../constants/nodes-job-name.constant';
import { INodeHealthCheckPayload } from '../interfaces';

@Processor(QUEUES_NAMES.NODES.HEALTH_CHECK, {
    concurrency: 40,
})
export class NodeHealthCheckQueueProcessor extends WorkerHost {
    private readonly logger = new Logger(NodeHealthCheckQueueProcessor.name);

    constructor(
        private readonly commandBus: CommandBus,
        private readonly axios: AxiosService,
        private readonly nodesQueuesService: NodesQueuesService,
        private readonly rawCacheService: RawCacheService,
    ) {
        super();
    }
    async process(job: Job<INodeHealthCheckPayload>) {
        try {
            const { nodeUuid, xrayConnected, connectionOpts } = job.data;

            const attemptsLimit = 2;
            let attempts = 0;

            let message = '';

            while (attempts < attemptsLimit) {
                const statResult = await this.axios.getSystemStats(connectionOpts);

                switch (statResult.isOk) {
                    case true:
                        return await this.handleConnectedNode(
                            connectionOpts,
                            nodeUuid,
                            xrayConnected,
                            statResult.response,
                        );
                    case false:
                        message = statResult.message ?? 'Unknown error';
                        attempts++;

                        this.logger.warn(
                            `Node ${nodeUuid}, ${connectionOpts.address}:${connectionOpts.port} – health check attempt ${attempts} of ${attemptsLimit}, message: ${message}`,
                        );

                        continue;
                    default:
                        message = 'Unknown error';
                        this.logger.error(
                            `Node ${nodeUuid}, ${connectionOpts.address}:${connectionOpts.port} – health check attempt ${attempts} of ${attemptsLimit}, message: ${message}`,
                        );

                        attempts++;
                        continue;
                }
            }

            return await this.handleDisconnectedNode(nodeUuid, xrayConnected, message);
        } catch (error) {
            this.logger.error(
                `Error handling "${NODES_JOB_NAMES.NODE_HEALTH_CHECK}" job: ${error}`,
            );
            return;
        }
    }

    private async handleConnectedNode(
        connectionOpts: INodeConnectionOpts,
        nodeUuid: string,
        xrayConnected: boolean,
        stats: GetSystemStatsCommand.Response['response'],
    ) {
        if (stats.xrayInfo === null) {
            this.logger.error(`Node ${nodeUuid} – xrayInfo is null`);

            await this.commandBus.execute(
                new UpdateNodeCommand({
                    uuid: nodeUuid,
                    xrayConnected: false,
                    xrayLastStatusChange: new Date(),
                    xrayLastStatusMessage: 'Required info is missing. Outdated version?',
                }),
            );

            return;
        }

        await this.rawCacheService.setMany([
            {
                key: CACHE_KEYS.NODE_SYSTEM_STATS(nodeUuid),
                value: stats.system.stats,
                ttlSeconds: CACHE_KEYS_TTL.NODE_SYSTEM_STATS,
            },
            {
                key: CACHE_KEYS.NODE_XRAY_UPTIME(nodeUuid),
                value: stats.xrayInfo.uptime,
                ttlSeconds: CACHE_KEYS_TTL.NODE_XRAY_UPTIME,
            },
        ]);

        const reports = stats.plugins.torrentBlocker.reportsCount;
        if (reports !== undefined && reports > 0) {
            await this.nodesQueuesService.collectReports({
                nodeUuid,
                connectionOpts,
            });

            this.logger.log(`Node ${nodeUuid} has ${reports} reports, collecting reports...`);
        }

        if (!xrayConnected) {
            const nodeUpdatedResponse = await this.commandBus.execute(
                new UpdateNodeCommand({
                    uuid: nodeUuid,
                    xrayConnected: true,
                }),
            );

            if (!nodeUpdatedResponse.isOk) {
                return;
            }

            await this.nodesQueuesService.startNode({ nodeUuid });
        }

        return;
    }

    private async handleDisconnectedNode(
        nodeUuid: string,
        xrayConnected: boolean,
        message: string | undefined,
    ) {
        await this.rawCacheService.delMany([
            CACHE_KEYS.NODE_SYSTEM_INFO(nodeUuid),
            CACHE_KEYS.NODE_USERS_ONLINE(nodeUuid),
            CACHE_KEYS.NODE_XRAY_UPTIME(nodeUuid),
        ]);

        const newNodeEntity = await this.commandBus.execute(
            new UpdateNodeCommand({
                uuid: nodeUuid,
                xrayConnected: false,
                xrayLastStatusChange: new Date(),
                xrayLastStatusMessage: message,
            }),
        );

        if (!newNodeEntity.isOk) {
            return;
        }

        await this.nodesQueuesService.startNode({ nodeUuid });

        this.logger.warn(
            `Lost connection to Node ${nodeUuid}, ${newNodeEntity.response.address}:${newNodeEntity.response.port}, message: ${message}`,
        );

        return;
    }
}
