import { ConfigProfiles } from '@prisma/client';

export class ConfigProfileEntity implements ConfigProfiles {
    public engine: string;
    public uuid: string;
    public viewPosition: number;
    public name: string;
    public tags: string[];
    public config: object;

    public createdAt: Date;
    public updatedAt: Date;

    constructor(configProfile: Partial<ConfigProfiles>) {
        this.engine = 'xray';
        Object.assign(this, configProfile);
        return this;
    }
}
