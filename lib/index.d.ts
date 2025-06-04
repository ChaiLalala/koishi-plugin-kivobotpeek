import { Context, Schema } from 'koishi';
export interface Config {
    port: number;
    authToken: string;
    commandPrefix: string;
    maxClients: number;
    responseTimeout: number;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
